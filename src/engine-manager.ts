import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { EngineType } from "./domain.ts";

export interface EngineCatalogEntry {
  id: EngineType;
  name: string;
  packageName: string;
  executableName: string;
  recommendedVersion: string;
  capabilities: string[];
}

export type EngineLifecycleStatus =
  | "absent"
  | "installing"
  | "updating"
  | "installed"
  | "disabled"
  | "failed";

export interface ManagedEngineState {
  id: EngineType;
  enabled: boolean;
  status: EngineLifecycleStatus;
  installedVersion?: string | undefined;
  installedVersions?: string[] | undefined;
  executable?: string | undefined;
  lastError?: string | undefined;
  lastOperation?: {
    action: "install" | "update";
    version: string;
    startedAt: string;
    finishedAt?: string | undefined;
    success?: boolean | undefined;
    log: string[];
  } | undefined;
  updatedAt: string;
}

export interface EnginePackageInstaller {
  install(
    packageSpec: string,
    prefix: string,
    signal: AbortSignal,
    onOutput?: ((text: string) => void) | undefined,
  ): Promise<void>;
}

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export const ENGINE_CATALOG: readonly EngineCatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    packageName: "@anthropic-ai/claude-code",
    executableName: "claude",
    recommendedVersion: "2.1.218",
    capabilities: ["stream-events", "sessions", "approval"],
  },
  {
    id: "codex",
    name: "Codex CLI",
    packageName: "@openai/codex",
    executableName: "codex",
    recommendedVersion: "0.145.0",
    capabilities: ["stream-events", "sessions", "approval"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    packageName: "openclaw",
    executableName: "openclaw",
    recommendedVersion: "2026.7.1-2",
    capabilities: ["stream-events", "sessions", "controlled-host-execution"],
  },
] as const;

interface PersistedState {
  schemaVersion: 1;
  engines: Partial<Record<EngineType, ManagedEngineState>>;
}

class NpmEnginePackageInstaller implements EnginePackageInstaller {
  async install(
    packageSpec: string,
    prefix: string,
    signal: AbortSignal,
    onOutput?: ((text: string) => void) | undefined,
  ): Promise<void> {
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    const child = spawn(
      process.env.HIBRO_NPM_BIN ?? "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--save=false",
        packageSpec,
      ],
      {
        env: {
          ...process.env,
          ...(process.env.HIBRO_NPM_REGISTRY
            ? { NPM_CONFIG_REGISTRY: process.env.HIBRO_NPM_REGISTRY }
            : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      onOutput?.(String(chunk));
      output = `${output}${String(chunk)}`.slice(-16_384);
    });
    child.stderr.on("data", (chunk) => {
      onOutput?.(String(chunk));
      output = `${output}${String(chunk)}`.slice(-16_384);
    });
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolveExit(code ?? 1));
    });
    if (exitCode !== 0) {
      throw new Error(`npm install exited with ${exitCode}: ${output.trim().slice(-2_000)}`);
    }
  }
}

export class EngineManager {
  readonly root: string;
  readonly stateFile: string;
  private readonly installer: EnginePackageInstaller;
  private readonly operations = new Set<EngineType>();
  private state: PersistedState = { schemaVersion: 1, engines: {} };

  constructor(
    root: string,
    options: { installer?: EnginePackageInstaller | undefined } = {},
  ) {
    this.root = resolve(root);
    this.stateFile = join(this.root, "state.json");
    this.installer = options.installer ?? new NpmEnginePackageInstaller();
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await rm(join(this.root, ".staging"), { recursive: true, force: true });
    await mkdir(join(this.root, ".staging"), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, "utf8")) as PersistedState;
      if (parsed.schemaVersion === 1 && parsed.engines && typeof parsed.engines === "object") {
        this.state = parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let changed = false;
    for (const engine of ENGINE_CATALOG) {
      const existing = this.state.engines[engine.id];
      const normalized = this.normalizeState(engine.id, existing);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(normalized)) changed = true;
      this.state.engines[engine.id] = normalized;
      if (normalized.installedVersion) {
        try {
          await access(this.executablePath(engine.id, normalized.installedVersion), constants.X_OK);
        } catch {
          this.state.engines[engine.id] = {
            ...normalized,
            status: "failed",
            lastError: "Managed executable is missing; reinstall this engine",
            updatedAt: new Date().toISOString(),
          };
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
  }

  catalog(): Array<EngineCatalogEntry & ManagedEngineState> {
    return ENGINE_CATALOG.map((entry) => ({
      ...entry,
      ...this.get(entry.id),
      capabilities: [...entry.capabilities],
    }));
  }

  get(id: EngineType): ManagedEngineState {
    const current = this.state.engines[id] ?? this.defaultState(id);
    return { ...current };
  }

  isEnabled(id: EngineType): boolean {
    return this.get(id).enabled;
  }

  resolveExecutable(id: EngineType, fallback: string): string {
    const state = this.get(id);
    if (!state.enabled || !state.installedVersion) return fallback;
    return this.executablePath(id, state.installedVersion);
  }

  async install(id: EngineType, requestedVersion?: string): Promise<ManagedEngineState> {
    const catalog = this.catalogEntry(id);
    const version = requestedVersion ?? catalog.recommendedVersion;
    if (!exactVersion.test(version)) {
      throw new Error("Engine version must be an exact version such as 1.2.3");
    }
    return this.exclusive(id, async () => {
      const previous = this.get(id);
      if (previous.installedVersion === version && previous.enabled) {
        try {
          await access(this.executablePath(id, version), constants.X_OK);
          return previous;
        } catch {
          // Repair an incomplete managed installation below.
        }
      }
      const operation = previous.installedVersion ? "updating" : "installing";
      const startedAt = new Date().toISOString();
      const operationLog = [`Installing ${catalog.packageName}@${version}`];
      await this.update(id, {
        ...previous,
        enabled: true,
        status: operation,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
        lastOperation: {
          action: previous.installedVersion ? "update" : "install",
          version,
          startedAt,
          log: [...operationLog],
        },
      });
      const staging = join(this.root, ".staging", `${id}-${randomUUID()}`);
      const target = this.versionRoot(id, version);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 10 * 60 * 1_000);
      timer.unref();
      try {
        await this.installer.install(
          `${catalog.packageName}@${version}`,
          staging,
          abort.signal,
          (output) => {
            operationLog.push(...sanitizeInstallOutput(output));
            if (operationLog.length > 100) operationLog.splice(0, operationLog.length - 100);
          },
        );
        const stagedExecutable = join(staging, "node_modules", ".bin", catalog.executableName);
        await access(stagedExecutable, constants.X_OK);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
        return await this.update(id, {
          id,
          enabled: true,
          status: "installed",
          installedVersion: version,
          installedVersions: [...new Set([...(previous.installedVersions ?? []), version])].sort(),
          executable: this.executablePath(id, version),
          updatedAt: new Date().toISOString(),
          lastOperation: {
            action: previous.installedVersion ? "update" : "install",
            version,
            startedAt,
            finishedAt: new Date().toISOString(),
            success: true,
            log: [...operationLog, `Activated ${catalog.executableName} ${version}`].slice(-100),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const safeMessage = sanitizeLogLine(message);
        await rm(staging, { recursive: true, force: true });
        await this.update(id, {
          ...previous,
          status: "failed",
          lastError: safeMessage,
          updatedAt: new Date().toISOString(),
          lastOperation: {
            action: previous.installedVersion ? "update" : "install",
            version,
            startedAt,
            finishedAt: new Date().toISOString(),
            success: false,
            log: [...operationLog, `Failed: ${safeMessage}`].slice(-100),
          },
        });
        throw new Error(`Failed to install ${catalog.name}: ${safeMessage}`);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async setEnabled(id: EngineType, enabled: boolean): Promise<ManagedEngineState> {
    this.catalogEntry(id);
    return this.exclusive(id, async () => {
      const current = this.get(id);
      return this.update(id, {
        ...current,
        enabled,
        status: enabled
          ? current.installedVersion
            ? "installed"
            : "absent"
          : "disabled",
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async activate(id: EngineType, version: string): Promise<ManagedEngineState> {
    this.catalogEntry(id);
    if (!exactVersion.test(version)) throw new Error("Engine version must be exact");
    return this.exclusive(id, async () => {
      const current = this.get(id);
      if (!(current.installedVersions ?? []).includes(version)) {
        throw new Error(`Managed engine version is not installed: ${id}@${version}`);
      }
      const executable = this.executablePath(id, version);
      await access(executable, constants.X_OK);
      return this.update(id, {
        ...current,
        enabled: true,
        status: "installed",
        installedVersion: version,
        executable,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async uninstall(id: EngineType): Promise<ManagedEngineState> {
    this.catalogEntry(id);
    return this.exclusive(id, async () => {
      await rm(join(this.root, id), { recursive: true, force: true });
      return this.update(id, {
        ...this.defaultState(id),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  private catalogEntry(id: EngineType): EngineCatalogEntry {
    const entry = ENGINE_CATALOG.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unsupported engine: ${id}`);
    return entry;
  }

  private versionRoot(id: EngineType, version: string): string {
    return join(this.root, id, "versions", version);
  }

  private executablePath(id: EngineType, version: string): string {
    return join(
      this.versionRoot(id, version),
      "node_modules",
      ".bin",
      this.catalogEntry(id).executableName,
    );
  }

  private defaultState(id: EngineType): ManagedEngineState {
    return {
      id,
      enabled: true,
      status: "absent",
      updatedAt: new Date(0).toISOString(),
    };
  }

  private normalizeState(
    id: EngineType,
    candidate: ManagedEngineState | undefined,
  ): ManagedEngineState {
    if (!candidate || candidate.id !== id || typeof candidate.enabled !== "boolean") {
      return this.defaultState(id);
    }
    const statuses: EngineLifecycleStatus[] = [
      "absent", "installing", "updating", "installed", "disabled", "failed",
    ];
    const installedVersion = typeof candidate.installedVersion === "string" &&
      exactVersion.test(candidate.installedVersion)
      ? candidate.installedVersion
      : undefined;
    const installedVersions = Array.isArray(candidate.installedVersions)
      ? [...new Set(candidate.installedVersions.filter((version) =>
          typeof version === "string" && exactVersion.test(version),
        ))].sort()
      : installedVersion ? [installedVersion] : [];
    if (installedVersion && !installedVersions.includes(installedVersion)) {
      installedVersions.push(installedVersion);
      installedVersions.sort();
    }
    const persistedStatus = statuses.includes(candidate.status)
      ? candidate.status
      : installedVersion ? "installed" : "absent";
    const interrupted = persistedStatus === "installing" || persistedStatus === "updating";
    const status = interrupted ? "failed" : persistedStatus;
    return {
      id,
      enabled: candidate.enabled,
      status,
      ...(installedVersion
        ? {
            installedVersion,
            installedVersions,
            executable: this.executablePath(id, installedVersion),
          }
        : {}),
      ...(interrupted
        ? { lastError: "Previous engine operation was interrupted; retry the installation" }
        : typeof candidate.lastError === "string"
        ? { lastError: candidate.lastError.slice(0, 2_000) }
        : {}),
      ...(candidate.lastOperation && typeof candidate.lastOperation === "object"
        ? {
            lastOperation: {
              action: candidate.lastOperation.action === "update" ? "update" as const : "install" as const,
              version: typeof candidate.lastOperation.version === "string"
                ? candidate.lastOperation.version.slice(0, 64)
                : "unknown",
              startedAt: typeof candidate.lastOperation.startedAt === "string"
                ? candidate.lastOperation.startedAt
                : new Date(0).toISOString(),
              ...(typeof candidate.lastOperation.finishedAt === "string"
                ? { finishedAt: candidate.lastOperation.finishedAt }
                : {}),
              ...(typeof candidate.lastOperation.success === "boolean"
                ? { success: candidate.lastOperation.success }
                : {}),
              log: Array.isArray(candidate.lastOperation.log)
                ? candidate.lastOperation.log.filter((line) => typeof line === "string").slice(-100).map(sanitizeLogLine)
                : [],
            },
          }
        : {}),
      updatedAt: typeof candidate.updatedAt === "string"
        ? candidate.updatedAt
        : new Date(0).toISOString(),
    };
  }

  private async update(
    id: EngineType,
    state: ManagedEngineState,
  ): Promise<ManagedEngineState> {
    this.state.engines[id] = state;
    await this.persist();
    return { ...state };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.stateFile);
  }

  private async exclusive<T>(id: EngineType, operation: () => Promise<T>): Promise<T> {
    if (this.operations.has(id)) throw new Error(`Engine operation already in progress: ${id}`);
    this.operations.add(id);
    try {
      return await operation();
    } finally {
      this.operations.delete(id);
    }
  }
}

function sanitizeInstallOutput(output: string): string[] {
  return output.split(/\r?\n/).map(sanitizeLogLine).filter(Boolean).slice(-100);
}

function sanitizeLogLine(line: string): string {
  return line
    .replace(/\b(token|password|secret|authorization|access[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .slice(0, 1_000);
}
