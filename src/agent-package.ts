import { createHash } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  AgentDefinition,
  ApprovalPolicy,
  EngineType,
  WorkspaceAccessMode,
  WorkspaceStrategy,
} from "./domain.ts";
import type { FileAgentRegistry } from "./agent-registry.ts";
import { createId } from "./identity.ts";
import { writeJsonAtomically } from "./storage.ts";

export const AGENT_API_VERSION = "hibro.ai/v1alpha1" as const;
export const AGENT_KIND = "Agent" as const;
export const AGENT_PACKAGE_LIMITS = {
  files: 256,
  fileBytes: 256 * 1024,
  totalBytes: 768 * 1024,
} as const;

export interface AgentManifest {
  apiVersion: typeof AGENT_API_VERSION;
  kind: typeof AGENT_KIND;
  metadata: {
    name: string;
    slug: string;
    description?: string | undefined;
  };
  spec: {
    engine: EngineType;
    instructions: string;
    skills?: Array<{ name: string; path: string }> | undefined;
    workspace?: {
      strategy?: WorkspaceStrategy | undefined;
      access?: WorkspaceAccessMode | undefined;
    } | undefined;
    model?: string | undefined;
    allowedTools?: string[] | undefined;
    approvalPolicy?: ApprovalPolicy | undefined;
    allowDangerousSandbox?: boolean | undefined;
    maxConcurrency?: number | undefined;
  };
}

export interface AgentPackageBundle {
  manifest: AgentManifest;
  files: Record<string, string>;
}

export interface InstalledAgentRevision {
  agentId: string;
  definitionId?: string | undefined;
  revisionId: string;
  revision: number;
  contentHash: string;
  origin: "local" | "hibro-core";
  status: "active" | "inactive";
  installedAt: string;
  activatedAt?: string | undefined;
  manifest: AgentManifest;
}

const engines = new Set<EngineType>(["claude-code", "codex", "openclaw"]);
const strategies = new Set<WorkspaceStrategy>(["persistent", "per-run", "scratch"]);
const accesses = new Set<WorkspaceAccessMode>(["read-only", "workspace-write"]);
const approvals = new Set<ApprovalPolicy>(["strict", "workspace", "unrestricted"]);

function validateStorageId(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

export function normalizePackagePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new Error(`invalid Agent package path: ${value || "<empty>"}`);
  }
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized !== value
  ) {
    throw new Error(`Agent package path must be a normalized relative path: ${value}`);
  }
  return normalized;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

export function validateAgentManifest(value: unknown): AgentManifest {
  const root = asObject(value, "manifest");
  if (root.apiVersion !== AGENT_API_VERSION) {
    throw new Error(`apiVersion must be ${AGENT_API_VERSION}`);
  }
  if (root.kind !== AGENT_KIND) throw new Error(`kind must be ${AGENT_KIND}`);
  const metadata = asObject(root.metadata, "metadata");
  const spec = asObject(root.spec, "spec");
  const slug = requiredString(metadata.slug, "metadata.slug");
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) {
    throw new Error("metadata.slug must be 3-64 lowercase letters, numbers or dashes");
  }
  const engine = requiredString(spec.engine, "spec.engine") as EngineType;
  if (!engines.has(engine)) throw new Error(`unsupported engine: ${engine}`);
  const instructions = normalizePackagePath(requiredString(spec.instructions, "spec.instructions"));
  const workspaceValue = spec.workspace === undefined
    ? {}
    : asObject(spec.workspace, "spec.workspace");
  const strategy = (workspaceValue.strategy ?? "persistent") as WorkspaceStrategy;
  const workspaceAccess = (workspaceValue.access ?? "workspace-write") as WorkspaceAccessMode;
  if (!strategies.has(strategy)) throw new Error(`unsupported workspace strategy: ${strategy}`);
  if (!accesses.has(workspaceAccess)) throw new Error(`unsupported workspace access: ${workspaceAccess}`);
  const approvalPolicy = (spec.approvalPolicy ?? "workspace") as ApprovalPolicy;
  if (!approvals.has(approvalPolicy)) throw new Error(`unsupported approval policy: ${approvalPolicy}`);
  const allowDangerousSandbox = spec.allowDangerousSandbox === true;
  if (approvalPolicy === "unrestricted" && (!allowDangerousSandbox || workspaceAccess !== "workspace-write")) {
    throw new Error("unrestricted approval policy requires workspace-write and allowDangerousSandbox");
  }
  const maxConcurrency = spec.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || Number(maxConcurrency) < 1 || Number(maxConcurrency) > 32) {
    throw new Error("spec.maxConcurrency must be an integer from 1 to 32");
  }
  const skills = spec.skills === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(spec.skills)) throw new Error("spec.skills must be an array");
        const names = new Set<string>();
        return spec.skills.map((value, index) => {
          const skill = asObject(value, `spec.skills[${index}]`);
          const name = requiredString(skill.name, `spec.skills[${index}].name`);
          if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || names.has(name)) {
            throw new Error(`invalid or duplicate skill name: ${name}`);
          }
          names.add(name);
          return { name, path: normalizePackagePath(requiredString(skill.path, `spec.skills[${index}].path`)) };
        });
      })();
  const allowedTools = spec.allowedTools === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(spec.allowedTools) || spec.allowedTools.some((item) => typeof item !== "string" || !item.trim())) {
          throw new Error("spec.allowedTools must contain non-empty strings");
        }
        return [...new Set((spec.allowedTools as string[]).map((item) => item.trim()))];
      })();
  return {
    apiVersion: AGENT_API_VERSION,
    kind: AGENT_KIND,
    metadata: {
      name: requiredString(metadata.name, "metadata.name"),
      slug,
      ...(typeof metadata.description === "string" && metadata.description.trim()
        ? { description: metadata.description.trim() }
        : {}),
    },
    spec: {
      engine,
      instructions,
      ...(skills?.length ? { skills } : {}),
      workspace: { strategy, access: workspaceAccess },
      ...(typeof spec.model === "string" && spec.model.trim() ? { model: spec.model.trim() } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      approvalPolicy,
      allowDangerousSandbox,
      maxConcurrency: Number(maxConcurrency),
    },
  };
}

export function validateAgentPackage(bundle: unknown): AgentPackageBundle {
  const source = asObject(bundle, "Agent package");
  const manifest = validateAgentManifest(source.manifest);
  const rawFiles = asObject(source.files, "files");
  const entries = Object.entries(rawFiles);
  if (entries.length > AGENT_PACKAGE_LIMITS.files) throw new Error("Agent package has too many files");
  let totalBytes = 0;
  const files: Record<string, string> = {};
  for (const [rawPath, rawContent] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const path = normalizePackagePath(rawPath);
    if (typeof rawContent !== "string") throw new Error(`Agent package file must be text: ${path}`);
    const content = rawContent.replaceAll("\r\n", "\n");
    const bytes = Buffer.byteLength(content);
    if (bytes > AGENT_PACKAGE_LIMITS.fileBytes) throw new Error(`Agent package file exceeds 256 KiB: ${path}`);
    totalBytes += bytes;
    if (totalBytes > AGENT_PACKAGE_LIMITS.totalBytes) throw new Error("Agent package exceeds 768 KiB");
    files[path] = content;
  }
  if (!(manifest.spec.instructions in files)) {
    throw new Error(`instructions file is missing: ${manifest.spec.instructions}`);
  }
  for (const skill of manifest.spec.skills ?? []) {
    if (!(`${skill.path}/SKILL.md` in files)) throw new Error(`Skill is missing SKILL.md: ${skill.path}`);
    if (Object.keys(files).every((path) => path !== skill.path && !path.startsWith(`${skill.path}/`))) {
      throw new Error(`Skill path is empty: ${skill.path}`);
    }
  }
  return { manifest, files };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function agentPackageHash(bundle: AgentPackageBundle): string {
  const checked = validateAgentPackage(bundle);
  return createHash("sha256").update(canonical(checked)).digest("hex");
}

export function parseAgentManifest(source: string): AgentManifest {
  return validateAgentManifest(parseYaml(source));
}

async function collectFiles(root: string, directory = root, files: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in Agent packages: ${path}`);
    if (entry.isDirectory()) await collectFiles(root, absolute, files);
    else if (entry.isFile() && path !== "agent.yaml") files[normalizePackagePath(path)] = await readFile(absolute, "utf8");
  }
  return files;
}

export async function readAgentPackage(rootPath: string): Promise<AgentPackageBundle> {
  const root = resolve(rootPath);
  if (!(await lstat(root)).isDirectory()) throw new Error("Agent package path must be a directory");
  const manifest = parseAgentManifest(await readFile(join(root, "agent.yaml"), "utf8"));
  return validateAgentPackage({ manifest, files: await collectFiles(root) });
}

export class AgentPackageManager {
  private readonly agentsRoot: string;
  private readonly registry: FileAgentRegistry;

  constructor(
    agentsRoot: string,
    registry: FileAgentRegistry,
  ) {
    this.agentsRoot = agentsRoot;
    this.registry = registry;
  }

  async deploy(input: {
    agentId?: string;
    definitionId?: string;
    revisionId?: string;
    revision?: number;
    expectedHash?: string;
    origin: "local" | "hibro-core";
    bundle: AgentPackageBundle;
  }): Promise<InstalledAgentRevision> {
    const bundle = validateAgentPackage(input.bundle);
    const contentHash = agentPackageHash(bundle);
    if (input.expectedHash && input.expectedHash !== contentHash) throw new Error("Agent package hash mismatch");
    const agentId = validateStorageId(input.agentId ?? createId("agt"), "agentId");
    const revisionId = validateStorageId(
      input.revisionId ?? `arev_${contentHash.slice(0, 32)}`,
      "revisionId",
    );
    const revision = input.revision ?? 1;
    const root = this.revisionsRoot(agentId);
    const destination = join(root, revisionId);
    const current = await this.getRevision(agentId, revisionId);
    if (!current) {
      const staging = `${destination}.tmp-${process.pid}-${Date.now()}`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(join(staging, "source"), { recursive: true, mode: 0o700 });
      await writeFile(join(staging, "source", "agent.yaml"), stringifyYaml(bundle.manifest), { mode: 0o600 });
      for (const [path, content] of Object.entries(bundle.files)) {
        const target = join(staging, "source", ...path.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
      await this.compile(staging, bundle);
      const metadata: InstalledAgentRevision = {
        agentId,
        definitionId: input.definitionId,
        revisionId,
        revision,
        contentHash,
        origin: input.origin,
        status: "inactive",
        installedAt: new Date().toISOString(),
        manifest: bundle.manifest,
      };
      await writeFile(join(staging, "revision.json"), JSON.stringify(metadata, null, 2), { mode: 0o600 });
      await mkdir(root, { recursive: true, mode: 0o700 });
      await rename(staging, destination).catch(async (error: NodeJS.ErrnoException) => {
        await rm(staging, { recursive: true, force: true });
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      });
    } else if (current.contentHash !== contentHash) {
      throw new Error("revisionId already exists with different content");
    }
    return this.activate(agentId, revisionId, input.origin, input.definitionId);
  }

  async activate(
    agentId: string,
    revisionId: string,
    origin?: "local" | "hibro-core",
    definitionId?: string,
  ): Promise<InstalledAgentRevision> {
    validateStorageId(agentId, "agentId");
    validateStorageId(revisionId, "revisionId");
    const stored = await this.getRevision(agentId, revisionId);
    if (!stored) throw new Error(`Agent revision not found: ${revisionId}`);
    const activatedAt = new Date().toISOString();
    const active: InstalledAgentRevision = { ...stored, status: "active", activatedAt };
    const previous = this.registry.get(agentId);
    const manifest = stored.manifest;
    try {
      await this.registry.upsert({
        id: agentId,
        name: manifest.metadata.name,
        description: manifest.metadata.description,
        engine: manifest.spec.engine,
        enabled: previous?.enabled ?? true,
        source: previous?.source,
        workspace: {
          strategy: manifest.spec.workspace?.strategy ?? "persistent",
          access: manifest.spec.workspace?.access ?? "workspace-write",
        },
        maxConcurrency: manifest.spec.maxConcurrency ?? 1,
        model: manifest.spec.model,
        instructions: undefined,
        allowedTools: manifest.spec.allowedTools,
        approvalPolicy: manifest.spec.approvalPolicy ?? "workspace",
        allowDangerousSandbox: manifest.spec.allowDangerousSandbox ?? false,
        package: {
          definitionId: definitionId ?? stored.definitionId,
          revisionId,
          revision: stored.revision,
          contentHash: stored.contentHash,
          origin: origin ?? stored.origin,
          activatedAt,
        },
      });
      await writeJsonAtomically(this.activePath(agentId), active);
    } catch (error) {
      if (previous) await this.registry.upsert(previous).catch(() => undefined);
      else await this.registry.delete(agentId).catch(() => undefined);
      throw error;
    }
    return active;
  }

  async list(agentId?: string): Promise<InstalledAgentRevision[]> {
    if (agentId) validateStorageId(agentId, "agentId");
    const agentIds = agentId
      ? [agentId]
      : (await readdir(this.agentsRoot, { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
    const result: InstalledAgentRevision[] = [];
    for (const id of agentIds) {
      const active = await this.active(id);
      for (const revisionId of await readdir(this.revisionsRoot(id)).catch(() => [])) {
        const item = await this.getRevision(id, revisionId);
        if (item) result.push({ ...item, status: active?.revisionId === item.revisionId ? "active" : "inactive", ...(active?.revisionId === item.revisionId ? { activatedAt: active.activatedAt } : {}) });
      }
    }
    return result.sort((a, b) => b.revision - a.revision || b.installedAt.localeCompare(a.installedAt));
  }

  async active(agentId: string): Promise<InstalledAgentRevision | undefined> {
    validateStorageId(agentId, "agentId");
    try {
      return JSON.parse(await readFile(this.activePath(agentId), "utf8")) as InstalledAgentRevision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async materialize(agent: AgentDefinition, workspace: string): Promise<void> {
    validateStorageId(agent.id, "agentId");
    const revisionId = agent.package?.revisionId;
    if (!revisionId) return;
    const compiled = join(this.revisionsRoot(agent.id), revisionId, "compiled");
    await access(compiled);
    // A Definition may change engines between revisions. Remove every path owned
    // by the compiler so an earlier engine cannot leak stale instructions or
    // skills into the newly activated runtime.
    const managed = [
      "AGENTS.md",
      "CLAUDE.md",
      ".agents",
      ".claude",
      ".openclaw",
      ".hibro-agent.json",
    ];
    for (const path of managed) await rm(join(workspace, path), { recursive: true, force: true });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await cp(compiled, workspace, { recursive: true, force: true });
  }

  private async compile(root: string, bundle: AgentPackageBundle): Promise<void> {
    const compiled = join(root, "compiled");
    await mkdir(compiled, { recursive: true, mode: 0o700 });
    const instructions = bundle.files[bundle.manifest.spec.instructions]!;
    const engine = bundle.manifest.spec.engine;
    const instructionName = engine === "claude-code" ? "CLAUDE.md" : "AGENTS.md";
    await writeFile(join(compiled, instructionName), `${instructions.trim()}\n`, { mode: 0o600 });
    const skillsRoot = engine === "claude-code" ? ".claude/skills" : engine === "codex" ? ".agents/skills" : ".openclaw/skills";
    for (const skill of bundle.manifest.spec.skills ?? []) {
      for (const [path, content] of Object.entries(bundle.files)) {
        if (path !== skill.path && !path.startsWith(`${skill.path}/`)) continue;
        const relativePath = path === skill.path ? "SKILL.md" : path.slice(skill.path.length + 1);
        const target = join(compiled, ...skillsRoot.split("/"), skill.name, ...relativePath.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600 });
      }
    }
    await writeFile(join(compiled, ".hibro-agent.json"), JSON.stringify({ apiVersion: bundle.manifest.apiVersion, slug: bundle.manifest.metadata.slug, engine }, null, 2), { mode: 0o600 });
  }

  private revisionsRoot(agentId: string): string {
    validateStorageId(agentId, "agentId");
    return join(this.agentsRoot, agentId, "definition", "revisions");
  }

  private activePath(agentId: string): string {
    validateStorageId(agentId, "agentId");
    return join(this.agentsRoot, agentId, "definition", "active.json");
  }

  private async getRevision(agentId: string, revisionId: string): Promise<InstalledAgentRevision | undefined> {
    validateStorageId(agentId, "agentId");
    validateStorageId(revisionId, "revisionId");
    try {
      return JSON.parse(await readFile(join(this.revisionsRoot(agentId), revisionId, "revision.json"), "utf8")) as InstalledAgentRevision;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}
