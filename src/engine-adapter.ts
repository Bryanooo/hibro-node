import type { EngineRunOptions, EngineType } from "./domain.ts";

export interface EngineDoctorResult {
  executable?: string | undefined;
  version?: string | undefined;
  installed: boolean;
  ready: boolean;
  loggedIn?: boolean | undefined;
  authMethod?: string | undefined;
  error?: string | undefined;
  [key: string]: unknown;
}

export interface EngineExecuteInput {
  runId?: string | undefined;
  agentId?: string | undefined;
  prompt: string;
  workspace: string;
  statePath?: string | undefined;
  sessionKey?: string | undefined;
  options?: EngineRunOptions | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((type: string, payload: Record<string, unknown>) => void) | undefined;
  requestApproval?:
    | ((request: EngineApprovalRequest) => Promise<EngineApprovalDecision>)
    | undefined;
}

export type EngineApprovalDecision = "allow_once" | "allow_always" | "deny";

export interface EngineApprovalRequest {
  externalId: string;
  kind: "command" | "file_change" | "network" | "tool" | "permission";
  title: string;
  detail?: string | undefined;
  toolName?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  decisions?: EngineApprovalDecision[] | undefined;
}

export interface EngineExecutionResult {
  sessionId?: string | undefined;
  result: string;
  rawResult?: Record<string, unknown> | undefined;
}

export interface AgentEngineAdapter {
  readonly engineType: EngineType;
  doctor(): Promise<EngineDoctorResult>;
  execute(input: EngineExecuteInput): Promise<EngineExecutionResult>;
}

export class EngineProcessError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "EngineProcessError";
    this.code = code;
    this.details = details;
  }
}

export class EngineRegistry {
  private readonly adapters = new Map<EngineType, AgentEngineAdapter>();

  constructor(adapters: AgentEngineAdapter[]) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.engineType, adapter);
    }
  }

  get(engine: EngineType): AgentEngineAdapter | undefined {
    return this.adapters.get(engine);
  }

  list(): AgentEngineAdapter[] {
    return [...this.adapters.values()];
  }
}
