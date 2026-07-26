export const RUN_STATUSES = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const ENGINE_TYPES = ["claude-code", "codex", "openclaw"] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

export const WORKSPACE_MODES = [
  "shared-readonly",
  "exclusive-local",
  "persistent-worktree",
  "ephemeral-worktree",
  "scratch",
] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const WORKSPACE_STRATEGIES = ["persistent", "per-run", "scratch"] as const;
export type WorkspaceStrategy = (typeof WORKSPACE_STRATEGIES)[number];

export const WORKSPACE_ACCESS_MODES = ["read-only", "workspace-write"] as const;
export type WorkspaceAccessMode = (typeof WORKSPACE_ACCESS_MODES)[number];

export interface AgentSource {
  type: "local";
  path: string;
}

export interface AgentWorkspaceConfig {
  strategy: WorkspaceStrategy;
  access: WorkspaceAccessMode;
}

export type CoreRegistrationStatus =
  | "standalone"
  | "pending"
  | "registered"
  | "syncing"
  | "rejected"
  | "error";

export interface AgentCoreRegistration {
  status: CoreRegistrationStatus;
  coreAgentId?: string | undefined;
  registeredAt?: string | undefined;
  lastSyncedAt?: string | undefined;
  error?: string | undefined;
}

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

export interface ClaudeRunOptions {
  model?: string | undefined;
  sessionId?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  allowedTools?: string[] | undefined;
  appendSystemPrompt?: string | undefined;
  maxBudgetUsd?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface EngineRunOptions extends ClaudeRunOptions {
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | undefined;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string | undefined;
  engine: EngineType;
  enabled: boolean;
  source: AgentSource;
  workspace: AgentWorkspaceConfig;
  maxConcurrency: number;
  model?: string | undefined;
  instructions?: string | undefined;
  allowedTools?: string[] | undefined;
  allowDangerousSandbox?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntime {
  agent: AgentDefinition;
  status: "idle" | "running" | "unavailable" | "disabled";
  activeRunIds: string[];
  lastRunAt?: string | undefined;
  engineAvailable: boolean;
  engineVersion?: string | undefined;
  engineError?: string | undefined;
  coreRegistration: AgentCoreRegistration;
  paths: {
    workspace: string;
    state: string;
    temp: string;
    artifacts: string;
  };
}

export interface WorkspaceLease {
  id: string;
  strategy: WorkspaceStrategy;
  access: WorkspaceAccessMode;
  path: string;
  sourcePath: string;
  /** Writable Git metadata used to manage an isolated worktree. */
  gitRepositoryPath?: string | undefined;
  statePath: string;
  tempPath: string;
  materialization: "git-worktree" | "directory-copy" | "scratch";
  writable: boolean;
  artifactPath?: string | undefined;
  /** Legacy run-history compatibility. */
  mode?: WorkspaceMode | undefined;
  /** Legacy run-history compatibility. */
  projectRoot?: string | undefined;
}

export interface SystemSettings {
  nodeName: string;
  nodeId: string;
  defaultTimeoutMs: number;
  maxConcurrentRuns: number;
  allowDangerousSandbox: boolean;
  autoResumeSessions: boolean;
  eventRetentionDays: number;
  coreUrl?: string | undefined;
  coreToken?: string | undefined;
  coreEnabled: boolean;
  updatedAt: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  agentId?: string | undefined;
  engine: EngineType;
  title: string;
  content?: string | undefined;
  localPath?: string | undefined;
  contentType?: string | undefined;
  previewKind?:
    | "markdown"
    | "text"
    | "code"
    | "json"
    | "html"
    | "image"
    | "pdf"
    | "video"
    | "audio"
    | "unknown"
    | undefined;
  fileName?: string | undefined;
  relativePath?: string | undefined;
  sizeBytes?: number | undefined;
  sha256?: string | undefined;
  encoding?: "utf8" | "base64" | undefined;
  createdAt: string;
  workspacePath?: string | undefined;
  sync?: {
    status: "local_only" | "pending" | "uploading" | "synced" | "failed";
    synced: boolean;
    target: "hibro-core";
    updatedAt?: string | undefined;
    error?: string | undefined;
  } | undefined;
}

export interface CreateRunInput {
  prompt: string;
  agentId?: string | undefined;
  workspace?: string | undefined;
  sessionKey?: string | undefined;
  freshSession?: boolean | undefined;
  options?: EngineRunOptions;
  metadata?: Record<string, unknown>;
}

export interface RunError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  agentId?: string;
  engine: EngineType;
  status: RunStatus;
  request: CreateRunInput;
  workspace?: WorkspaceLease;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  result?: string;
  error?: RunError;
}

export interface RunEvent {
  runId: string;
  sequence: number;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}
