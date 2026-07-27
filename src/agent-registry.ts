import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  APPROVAL_POLICIES,
  ENGINE_TYPES,
  WORKSPACE_ACCESS_MODES,
  WORKSPACE_STRATEGIES,
  type ApprovalPolicy,
  type AgentDefinition,
  type AgentWorkspaceConfig,
  type EngineType,
  type WorkspaceMode,
} from "./domain.ts";
import { writeJsonAtomically } from "./storage.ts";
import { createId } from "./identity.ts";

type CreateAgentInput = Omit<AgentDefinition, "id" | "createdAt" | "updatedAt">;

interface LegacyAgentDefinition {
  id?: string;
  name?: string;
  description?: string;
  engine?: EngineType;
  enabled?: boolean;
  projectRoot?: string;
  workspaceMode?: WorkspaceMode;
  source?: AgentDefinition["source"];
  workspace?: AgentDefinition["workspace"];
  maxConcurrency?: number;
  model?: string;
  instructions?: string;
  allowedTools?: string[];
  approvalPolicy?: ApprovalPolicy;
  allowDangerousSandbox?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
    throw new Error("agent id must contain 2-64 letters, numbers, dots, dashes or underscores");
  }
}

export function createAgentId(): string {
  return createId("agt");
}

function migrateWorkspace(mode?: WorkspaceMode): AgentWorkspaceConfig {
  if (mode === "shared-readonly") return { strategy: "persistent", access: "read-only" };
  if (mode === "ephemeral-worktree") {
    return { strategy: "per-run", access: "workspace-write" };
  }
  if (mode === "scratch") return { strategy: "scratch", access: "workspace-write" };
  return { strategy: "persistent", access: "workspace-write" };
}

export class FileAgentRegistry {
  private readonly path: string;
  private agents = new Map<string, AgentDefinition>();

  constructor(path: string, _legacyDefaultProjectRoot = process.cwd()) {
    this.path = path;
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const values = JSON.parse(await readFile(this.path, "utf8")) as LegacyAgentDefinition[];
      this.agents = new Map(
        values.map((value) => {
          const agent = this.normalize(value);
          return [agent.id, agent];
        }),
      );
      this.ensureMinimumAgents();
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      for (const agent of this.defaultAgents()) this.agents.set(agent.id, agent);
      await this.persist();
    }
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  default(): AgentDefinition | undefined {
    return this.list().find((agent) => agent.enabled);
  }

  async create(input: CreateAgentInput): Promise<AgentDefinition> {
    let id = createAgentId();
    while (this.agents.has(id)) id = createAgentId();
    return this.upsert({ ...input, id });
  }

  async upsert(
    input: Partial<AgentDefinition> &
      Pick<AgentDefinition, "id" | "name" | "engine" | "workspace">,
  ): Promise<AgentDefinition> {
    validateId(input.id);
    if (!input.name.trim()) throw new Error("agent name is required");
    if (!ENGINE_TYPES.includes(input.engine)) throw new Error(`unsupported engine: ${input.engine}`);
    if (
      input.source &&
      (input.source.type !== "local" || !input.source.path.trim())
    ) {
      throw new Error("source path must be a non-empty local path");
    }
    if (!WORKSPACE_STRATEGIES.includes(input.workspace.strategy)) {
      throw new Error(`unsupported workspace strategy: ${input.workspace.strategy}`);
    }
    if (!WORKSPACE_ACCESS_MODES.includes(input.workspace.access)) {
      throw new Error(`unsupported workspace access: ${input.workspace.access}`);
    }
    const now = new Date().toISOString();
    const previous = this.agents.get(input.id);
    const agent: AgentDefinition = {
      id: input.id,
      name: input.name.trim(),
      description: input.description?.trim() || undefined,
      engine: input.engine,
      enabled: input.enabled ?? true,
      ...(input.source
        ? { source: { type: "local" as const, path: resolve(input.source.path) } }
        : {}),
      workspace: { ...input.workspace },
      maxConcurrency: input.maxConcurrency ?? 1,
      model: input.model?.trim() || undefined,
      instructions: input.instructions?.trim() || undefined,
      allowedTools: input.allowedTools,
      approvalPolicy: input.approvalPolicy ?? "workspace",
      allowDangerousSandbox: input.allowDangerousSandbox ?? false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (!Number.isInteger(agent.maxConcurrency) || agent.maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    const validated = this.validateNormalized(agent);
    this.agents.set(validated.id, validated);
    await this.persist();
    return validated;
  }

  async delete(id: string): Promise<boolean> {
    validateId(id);
    const deleted = this.agents.delete(id);
    if (deleted) await this.persist();
    return deleted;
  }

  private normalize(value: LegacyAgentDefinition): AgentDefinition {
    const now = new Date().toISOString();
    const id = value.id ?? createAgentId();
    const sourcePath = value.source?.path ?? value.projectRoot;
    return this.validateNormalized({
      id,
      name: value.name ?? "Unnamed Agent",
      description: value.description,
      engine: value.engine ?? "claude-code",
      enabled: value.enabled ?? true,
      ...(sourcePath
        ? { source: { type: "local" as const, path: resolve(sourcePath) } }
        : {}),
      workspace: value.workspace ?? migrateWorkspace(value.workspaceMode),
      maxConcurrency: value.maxConcurrency ?? 1,
      model: value.model,
      instructions: value.instructions,
      allowedTools: value.allowedTools,
      approvalPolicy: value.approvalPolicy ?? "workspace",
      allowDangerousSandbox: value.allowDangerousSandbox ?? false,
      createdAt: value.createdAt ?? now,
      updatedAt: value.updatedAt ?? now,
    });
  }

  private validateNormalized(agent: AgentDefinition): AgentDefinition {
    validateId(agent.id);
    if (!ENGINE_TYPES.includes(agent.engine)) throw new Error(`unsupported engine: ${agent.engine}`);
    if (!WORKSPACE_STRATEGIES.includes(agent.workspace.strategy)) {
      throw new Error(`unsupported workspace strategy: ${agent.workspace.strategy}`);
    }
    if (!WORKSPACE_ACCESS_MODES.includes(agent.workspace.access)) {
      throw new Error(`unsupported workspace access: ${agent.workspace.access}`);
    }
    if (
      agent.approvalPolicy &&
      !APPROVAL_POLICIES.includes(agent.approvalPolicy)
    ) {
      throw new Error(`unsupported approval policy: ${agent.approvalPolicy}`);
    }
    if (
      agent.approvalPolicy === "unrestricted" &&
      (agent.allowDangerousSandbox !== true ||
        agent.workspace.access !== "workspace-write")
    ) {
      throw new Error(
        "unrestricted approval policy requires a writable Agent with danger-full-access enabled",
      );
    }
    if (!Number.isInteger(agent.maxConcurrency) || agent.maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    return agent;
  }

  private defaultAgents(): AgentDefinition[] {
    return ENGINE_TYPES.flatMap((engine) => [
      this.createDefaultAgent(engine, 0),
      this.createDefaultAgent(engine, 1),
    ]);
  }

  private ensureMinimumAgents(): void {
    for (const engine of ENGINE_TYPES) {
      let count = this.list().filter((agent) => agent.engine === engine).length;
      while (count < 2) {
        const agent = this.createDefaultAgent(engine, count);
        this.agents.set(agent.id, agent);
        count += 1;
      }
    }
  }

  private createDefaultAgent(engine: EngineType, index: number): AgentDefinition {
    const now = new Date().toISOString();
    const variants: Record<
      EngineType,
      Array<{
        name: string;
        description: string;
        access: AgentWorkspaceConfig["access"];
        allowedTools?: string[] | undefined;
      }>
    > = {
      "claude-code": [
        {
          name: "Claude 分析助手",
          description: "适合分析、检索和长文本推理",
          access: "read-only",
          allowedTools: ["Read", "Grep", "Glob"],
        },
        {
          name: "Claude 实作助手",
          description: "适合在独立工作区中修改代码和验证方案",
          access: "workspace-write",
          allowedTools: ["Read", "Grep", "Glob", "Write", "Edit", "Bash"],
        },
      ],
      codex: [
        {
          name: "Codex 开发助手",
          description: "适合实现功能、运行测试和修复问题",
          access: "workspace-write",
        },
        {
          name: "Codex 审查助手",
          description: "适合代码审查、重构和独立方案验证",
          access: "workspace-write",
        },
      ],
      openclaw: [
        {
          name: "OpenClaw 研究助手",
          description: "适合使用 OpenClaw 完成研究、归纳与协作任务",
          access: "read-only",
        },
        {
          name: "OpenClaw 自动化助手",
          description: "适合在受控工作区中执行多步骤自动化任务",
          access: "workspace-write",
        },
      ],
    };
    const variant = variants[engine][index] ?? variants[engine][0]!;
    return {
      id: createAgentId(),
      name: variant.name,
      engine,
      description: variant.description,
      enabled: true,
      workspace: { strategy: "persistent", access: variant.access },
      maxConcurrency: 1,
      allowedTools: variant.allowedTools,
      approvalPolicy: "workspace",
      allowDangerousSandbox: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async persist(): Promise<void> {
    await writeJsonAtomically(this.path, this.list());
  }
}
