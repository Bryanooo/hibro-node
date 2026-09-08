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
  /** Ephemeral per-Run secrets. Never persist this map in Run records or events. */
  environment?: Record<string, string> | undefined;
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
      this.register(adapter);
    }
  }

  register(adapter: AgentEngineAdapter): void {
    if (this.adapters.has(adapter.engineType)) {
      throw new Error(`Engine adapter is already registered: ${adapter.engineType}`);
    }
    this.adapters.set(adapter.engineType, adapter);
  }

  get(engine: EngineType): AgentEngineAdapter | undefined {
    return this.adapters.get(engine);
  }

  list(): AgentEngineAdapter[] {
    return [...this.adapters.values()];
  }
}

export interface EngineProvider<TContext> {
  readonly id: EngineType;
  readonly version: string;
  readonly capabilities: string[];
  create(context: TContext): AgentEngineAdapter;
}

/**
 * Compile-time provider registry. Third-party providers can be registered by a
 * trusted distribution without changing RunManager or the protocol layer.
 */
export class EngineProviderRegistry<TContext> {
  private readonly providers = new Map<EngineType, EngineProvider<TContext>>();

  register(provider: EngineProvider<TContext>): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Engine provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  createAll(context: TContext): AgentEngineAdapter[] {
    return [...this.providers.values()].map((provider) => provider.create(context));
  }

  catalog(): Array<Pick<EngineProvider<TContext>, "id" | "version" | "capabilities">> {
    return [...this.providers.values()].map(({ id, version, capabilities }) => ({
      id,
      version,
      capabilities: [...capabilities],
    }));
  }
}
