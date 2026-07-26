import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { SystemSettings } from "./domain.ts";
import { writeJsonAtomically } from "./storage.ts";
import { isIP } from "node:net";

export class FileSettingsStore {
  private readonly path: string;
  private settings: SystemSettings;

  constructor(path: string) {
    this.path = path;
    this.settings = this.defaults();
  }

  async init(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.path, "utf8")) as Partial<SystemSettings>;
      this.settings = this.validate({ ...this.defaults(), ...stored });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
  }

  get(): SystemSettings {
    return structuredClone(this.settings);
  }

  async update(input: Partial<SystemSettings>): Promise<SystemSettings> {
    this.settings = this.validate({
      ...this.settings,
      ...input,
      updatedAt: new Date().toISOString(),
    });
    await this.persist();
    return this.get();
  }

  private defaults(): SystemSettings {
    return {
      nodeName: hostname(),
      nodeId: `node_${randomUUID()}`,
      defaultTimeoutMs: 300_000,
      maxConcurrentRuns: 4,
      allowDangerousSandbox: false,
      autoResumeSessions: true,
      eventRetentionDays: 30,
      coreEnabled: false,
      updatedAt: new Date().toISOString(),
    };
  }

  private validate(value: SystemSettings): SystemSettings {
    if (!value.nodeName?.trim()) throw new Error("nodeName is required");
    if (!/^node_[a-zA-Z0-9-]{8,}$/.test(value.nodeId)) {
      throw new Error("nodeId is invalid");
    }
    if (!Number.isInteger(value.defaultTimeoutMs) || value.defaultTimeoutMs < 1_000) {
      throw new Error("defaultTimeoutMs must be an integer of at least 1000");
    }
    if (!Number.isInteger(value.maxConcurrentRuns) || value.maxConcurrentRuns < 1) {
      throw new Error("maxConcurrentRuns must be a positive integer");
    }
    if (!Number.isInteger(value.eventRetentionDays) || value.eventRetentionDays < 1) {
      throw new Error("eventRetentionDays must be a positive integer");
    }
    if (value.coreEnabled && !value.coreUrl?.trim()) {
      throw new Error("coreUrl is required when Core is enabled");
    }
    if (value.coreEnabled && !value.coreToken?.trim()) {
      throw new Error("coreToken is required when Core is enabled");
    }
    if (value.coreUrl) {
      const url = new URL(value.coreUrl);
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
        throw new Error("coreUrl must use http, https, ws or wss");
      }
      if (
        ["http:", "ws:"].includes(url.protocol) &&
        !isPrivateCoreHostname(url.hostname) &&
        process.env.HIBRO_NODE_ALLOW_INSECURE_PUBLIC_CORE !== "true"
      ) {
        throw new Error(
          "Public Core connections must use https or wss",
        );
      }
    }
    return {
      ...value,
      nodeName: value.nodeName.trim(),
      coreUrl: value.coreUrl?.trim() || undefined,
      coreToken: value.coreToken?.trim() || undefined,
    };
  }

  private async persist(): Promise<void> {
    await writeJsonAtomically(this.path, this.settings);
  }
}

function isPrivateCoreHostname(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    value === "localhost" ||
    value === "::1" ||
    value === "host.docker.internal" ||
    value.endsWith(".local") ||
    value.startsWith("127.")
  ) {
    return true;
  }
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return version === 6 && (/^f[cd]/.test(value) || /^fe[89ab]/.test(value));
}
