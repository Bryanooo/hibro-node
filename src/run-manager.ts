import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import {
  isTerminalStatus,
  type ArtifactRecord,
  type AgentDefinition,
  type AgentRuntime,
  type AgentCoreRegistration,
  type CreateRunInput,
  type EngineType,
  type RunEvent,
  type RunRecord,
  type SystemSettings,
} from "./domain.ts";
import { ClaudeCodeAdapter } from "./claude-code-adapter.ts";
import {
  EngineProcessError,
  EngineRegistry,
  type AgentEngineAdapter,
  type EngineDoctorResult,
  type EngineExecutionResult,
  type EngineApprovalDecision,
  type EngineApprovalRequest,
} from "./engine-adapter.ts";
import { FileAgentRegistry } from "./agent-registry.ts";
import type { RunStore } from "./storage.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { FileSettingsStore } from "./settings-store.ts";

export interface RunManagerOptions {
  store: RunStore;
  adapter?: AgentEngineAdapter | undefined;
  adapters?: AgentEngineAdapter[] | undefined;
  agents?: FileAgentRegistry | undefined;
  workspaces?: WorkspaceManager | undefined;
  settings?: FileSettingsStore | undefined;
}

interface DoctorCache {
  value: EngineDoctorResult;
  expiresAt: number;
}

export class RunManager {
  readonly store: RunStore;
  readonly adapter: AgentEngineAdapter;
  readonly agents: FileAgentRegistry | undefined;
  readonly workspaces: WorkspaceManager;
  readonly engines: EngineRegistry;
  readonly settings: FileSettingsStore;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingApprovals = new Map<
    string,
    {
      runId: string;
      request: EngineApprovalRequest;
      resolve: (decision: EngineApprovalDecision) => void;
    }
  >();
  private readonly sessionApprovals = new Map<string, number>();
  private readonly activeRuns = new Map<string, RunRecord>();
  private pendingRunReservations = 0;
  private readonly pendingAgentReservations = new Map<string, number>();
  private readonly stateWrites = new Map<string, Promise<void>>();
  private readonly sequences = new Map<string, number>();
  private readonly sessions = new Map<string, string>();
  private readonly doctorCache = new Map<EngineType, DoctorCache>();
  private readonly events = new EventEmitter();
  private readonly coreRegistrations = new Map<string, AgentCoreRegistration>();
  private coreConnection: {
    connected: boolean;
    status: "standalone" | "connecting" | "connected" | "error";
    error?: string | undefined;
    connectedAt?: string | undefined;
    lastMessageAt?: string | undefined;
  } = { connected: false, status: "standalone" };

  constructor(options: RunManagerOptions) {
    this.store = options.store;
    const claude: AgentEngineAdapter =
      options.adapter ??
      options.adapters?.find((candidate) => candidate.engineType === "claude-code") ??
      new ClaudeCodeAdapter();
    this.adapter = claude;
    this.engines = new EngineRegistry(options.adapters ?? [claude]);
    this.agents = options.agents;
    this.workspaces =
      options.workspaces ?? new WorkspaceManager(resolve(this.store.rootDir, "agents"));
    this.settings =
      options.settings ?? new FileSettingsStore(join(this.store.rootDir, "settings.json"));
    this.events.setMaxListeners(100);
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.agents?.init();
    await this.settings.init();
    await this.recoverInterruptedRuns();
    await this.pruneExpiredHistory();
    for (const run of await this.store.list()) {
      if (
        run.sessionId &&
        run.agentId &&
        run.request.sessionKey?.trim() &&
        run.status === "completed"
      ) {
        this.sessions.set(this.sessionKey(run.agentId, run.request.sessionKey), run.sessionId);
      }
    }
  }

  async create(input: CreateRunInput): Promise<RunRecord> {
    this.validateInput(input);
    const settings = this.settings.get();
    const agent = this.resolveAgent(input);
    if (!agent.enabled) throw new Error(`Agent ${agent.id} is disabled`);
    const adapter = this.engines.get(agent.engine);
    if (!adapter) throw new Error(`Engine adapter is not available: ${agent.engine}`);
    this.reserveRunSlot(agent, settings.maxConcurrentRuns);
    const runId = randomUUID();
    let lease: RunRecord["workspace"];
    try {
      lease = await this.workspaces.acquire(agent, runId);
      const artifactPath = join(this.workspaces.pathsFor(agent.id).artifacts, runId);
      await mkdir(artifactPath, { recursive: true, mode: 0o700 });
      lease.artifactPath = artifactPath;
      const now = new Date().toISOString();
      const sessionId =
        input.freshSession === true ||
        !settings.autoResumeSessions ||
        (!input.sessionKey?.trim() && !input.options?.sessionId)
          ? undefined
          : input.options?.sessionId ??
            this.sessions.get(this.sessionKey(agent.id, input.sessionKey));
      const options = this.effectiveRunOptions(input, agent, settings, lease, artifactPath, sessionId);
      const run: RunRecord = {
        id: runId,
        agentId: agent.id,
        engine: agent.engine,
        status: "queued",
        request: {
          ...input,
          agentId: agent.id,
          workspace: lease.path,
          options,
        },
        workspace: lease,
        createdAt: now,
        updatedAt: now,
      };
      this.sequences.set(run.id, 0);
      await this.store.create(run);
      await this.emit(run.id, "run.created", {
        status: run.status,
        agentId: agent.id,
        engine: agent.engine,
        workspace: lease,
      });
      this.activeRuns.set(run.id, run);
      void this.execute(run, adapter);
      return run;
    } catch (error) {
      if (lease) {
        await this.workspaces.release(agent.id, runId, lease).catch(() => undefined);
      }
      throw error;
    } finally {
      this.releaseRunReservation(agent.id);
    }
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    return this.store.get(runId);
  }

  async list(): Promise<RunRecord[]> {
    return this.store.list();
  }

  async listArtifacts(): Promise<ArtifactRecord[]> {
    const artifacts: ArtifactRecord[] = [];
    for (const run of await this.store.list()) {
      if (run.status !== "completed") continue;
      if (run.result) {
        const content = run.result;
        artifacts.push({
          id: run.id,
          runId: run.id,
          agentId: run.agentId,
          engine: run.engine,
          title: run.request.prompt.split("\n")[0]?.slice(0, 100) || "Agent output",
          content,
          contentType: "text/markdown",
          previewKind: "markdown",
          fileName: "agent-result.md",
          sizeBytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
          encoding: "utf8",
          createdAt: run.finishedAt ?? run.updatedAt,
          workspacePath: run.workspace?.path,
        });
      }
      if (run.workspace?.artifactPath) {
        artifacts.push(
          ...(await this.scanArtifactDirectory(run, run.workspace.artifactPath)),
        );
      }
    }
    return artifacts.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | undefined> {
    return (await this.listArtifacts()).find((artifact) => artifact.id === artifactId);
  }

  private async scanArtifactDirectory(
    run: RunRecord,
    root: string,
  ): Promise<ArtifactRecord[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(
        () => [],
      )) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (files.length < 200) await visit(path);
        } else if (entry.isFile() && files.length < 200) {
          files.push(path);
        }
      }
    };
    await visit(root);
    const result: ArtifactRecord[] = [];
    for (const path of files) {
      const info = await stat(path);
      const maxBytes = Number(
        process.env.HIBRO_NODE_ARTIFACT_MAX_BYTES ?? String(1024 * 1024 * 1024),
      );
      if (info.size > maxBytes) continue;
      const detected = artifactType(path);
      const relativePath = relative(root, path);
      const sha256 = await hashFile(path);
      result.push({
        id: `artifact_${createHash("sha256")
          .update(`${run.id}:${relativePath}`)
          .digest("hex")
          .slice(0, 32)}`,
        runId: run.id,
        agentId: run.agentId,
        engine: run.engine,
        title: basename(path),
        localPath: path,
        contentType: detected.contentType,
        previewKind: detected.previewKind,
        fileName: basename(path),
        relativePath,
        sizeBytes: info.size,
        sha256,
        encoding: detected.encoding,
        createdAt: info.mtime.toISOString(),
        workspacePath: run.workspace?.path,
      });
    }
    return result;
  }

  async listWorkspaces(): Promise<
    Array<{
      id: string;
      agentId: string;
      agentName: string;
      strategy: AgentDefinition["workspace"]["strategy"];
      access: AgentDefinition["workspace"]["access"];
      path: string;
      sourcePath: string;
      statePath: string;
      tempPath: string;
      artifactsPath: string;
      writable: boolean;
      activeRunIds: string[];
      lastRunAt?: string | undefined;
    }>
  > {
    const runs = await this.store.list();
    return (this.agents?.list() ?? []).map((agent) => {
      const lastRun = runs.find((run) => run.agentId === agent.id);
      const paths = this.workspaces.pathsFor(agent.id);
      return {
        id: agent.id,
        agentId: agent.id,
        agentName: agent.name,
        strategy: agent.workspace.strategy,
        access: agent.workspace.access,
        path: this.workspaces.expectedWorkspacePath(agent),
        sourcePath: agent.source.path,
        statePath: paths.state,
        tempPath: paths.temp,
        artifactsPath: paths.artifacts,
        writable: agent.workspace.access === "workspace-write",
        activeRunIds: this.workspaces.activeRunIds(agent.id),
        lastRunAt: lastRun?.updatedAt,
      };
    });
  }

  getSettings(): SystemSettings {
    return this.settings.get();
  }

  async updateSettings(input: Partial<SystemSettings>): Promise<SystemSettings> {
    const settings = await this.settings.update(input);
    await this.pruneExpiredHistory();
    return settings;
  }

  async deleteAgent(agentId: string): Promise<boolean> {
    if (!this.agents) return false;
    if (this.workspaces.activeRunIds(agentId).length > 0) {
      throw new Error("Cannot delete an Agent while it is running");
    }
    return this.agents.delete(agentId);
  }

  activeRunCount(): number {
    return this.activeRuns.size;
  }

  clearDoctorCache(): void {
    this.doctorCache.clear();
  }

  async pruneExpiredHistory(now = new Date()): Promise<string[]> {
    const cutoff = new Date(
      now.getTime() - this.settings.get().eventRetentionDays * 24 * 60 * 60 * 1_000,
    );
    const removed = await this.store.pruneTerminalRunsBefore(cutoff);
    this.store.pruneProtocolHistory(cutoff);
    return removed;
  }

  async listAgents(): Promise<AgentRuntime[]> {
    const definitions = this.agents?.list() ?? [];
    const probes = await this.doctorEngines();
    const runs = await this.store.list();
    return definitions.map((agent) => {
      const probe = probes.find((value) => value.id === agent.engine)?.doctor;
      const activeRunIds = this.workspaces.activeRunIds(agent.id);
      const lastRun = runs.find((run) => run.agentId === agent.id);
      const paths = this.workspaces.pathsFor(agent.id);
      const coreEnabled = this.settings.get().coreEnabled;
      return {
        agent,
        status: !agent.enabled
          ? "disabled"
          : !probe?.ready
            ? "unavailable"
            : activeRunIds.length
              ? "running"
              : "idle",
        activeRunIds,
        lastRunAt: lastRun?.updatedAt,
        engineAvailable: probe?.ready === true,
        engineVersion: probe?.version,
        engineError: probe?.error,
        coreRegistration: coreEnabled
          ? this.coreRegistrations.get(agent.id) ?? {
              status: "pending" as const,
              error:
                this.coreConnection.error ??
                (this.coreConnection.connected
                  ? "已连接 Hibro Core，正在等待注册确认"
                  : "正在连接 Hibro Core"),
            }
          : { status: "standalone" as const },
        paths: {
          workspace: this.workspaces.expectedWorkspacePath(agent),
          state: paths.state,
          temp: paths.temp,
          artifacts: paths.artifacts,
        },
      };
    });
  }

  getAgent(agentId: string): AgentDefinition | undefined {
    return this.agents?.get(agentId);
  }

  setCoreRegistration(agentId: string, registration: AgentCoreRegistration): void {
    this.coreRegistrations.set(agentId, registration);
  }

  setCoreConnection(
    value: Partial<{
      connected: boolean;
      status: "standalone" | "connecting" | "connected" | "error";
      error?: string | undefined;
      connectedAt?: string | undefined;
      lastMessageAt?: string | undefined;
    }>,
  ): void {
    this.coreConnection = { ...this.coreConnection, ...value };
    if (value.connected === false) {
      for (const [agentId, registration] of this.coreRegistrations) {
        this.coreRegistrations.set(agentId, {
          ...registration,
          status: this.settings.get().coreEnabled ? "syncing" : "standalone",
        });
      }
    }
  }

  getCoreConnection(): typeof this.coreConnection {
    return { ...this.coreConnection };
  }

  async doctorEngines(): Promise<Array<{ id: EngineType; doctor: EngineDoctorResult }>> {
    return Promise.all(
      this.engines.list().map(async (adapter) => ({
        id: adapter.engineType,
        doctor: await this.cachedDoctor(adapter),
      })),
    );
  }

  async eventsAfter(runId: string, sequence = 0): Promise<RunEvent[]> {
    return this.store.getEvents(runId, sequence);
  }

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    this.events.on(runId, listener);
    return () => this.events.off(runId, listener);
  }

  subscribeAll(listener: (event: RunEvent) => void): () => void {
    this.events.on("*", listener);
    return () => this.events.off("*", listener);
  }

  async cancel(runId: string): Promise<RunRecord | undefined> {
    const run = this.activeRuns.get(runId) ?? (await this.store.get(runId));
    if (!run || isTerminalStatus(run.status)) return run;
    run.status = "cancelling";
    run.updatedAt = new Date().toISOString();
    this.controllers.get(runId)?.abort();
    for (const [key, approval] of this.pendingApprovals) {
      if (approval.runId !== runId) continue;
      this.pendingApprovals.delete(key);
      approval.resolve("deny");
    }
    await this.persist(run);
    await this.emit(runId, "run.cancelling", {});
    return run;
  }

  pendingApproval(runId: string, externalId: string): EngineApprovalRequest | undefined {
    return this.pendingApprovals.get(`${runId}:${externalId}`)?.request;
  }

  async decideApproval(
    runId: string,
    externalId: string,
    decision: EngineApprovalDecision,
  ): Promise<void> {
    const key = `${runId}:${externalId}`;
    const pending = this.pendingApprovals.get(key);
    if (!pending) throw new Error("Approval is no longer pending");
    const supported = pending.request.decisions ?? [
      "allow_once",
      "allow_always",
      "deny",
    ];
    if (!supported.includes(decision)) throw new Error("Unsupported approval decision");
    this.pendingApprovals.delete(key);
    if (decision === "allow_always") {
      this.sessionApprovals.set(
        this.approvalTrustKey(runId, pending.request),
        Date.now() + 8 * 60 * 60 * 1_000,
      );
    }
    await this.emit(runId, "engine.approval.resolved", {
      externalId,
      decision,
      request: pending.request,
    });
    pending.resolve(decision);
  }

  async waitForTerminal(runId: string): Promise<RunRecord> {
    const current = await this.store.get(runId);
    if (!current) throw new Error(`Run not found: ${runId}`);
    if (isTerminalStatus(current.status)) return current;
    return new Promise<RunRecord>((resolvePromise, reject) => {
      const unsubscribe = this.subscribe(runId, (event) => {
        if (event.type !== "run.completed" && event.type !== "run.failed") return;
        unsubscribe();
        void this.store
          .get(runId)
          .then((run) => {
            if (run) resolvePromise(run);
            else reject(new Error(`Run disappeared: ${runId}`));
          })
          .catch(reject);
      });
    });
  }

  private async execute(run: RunRecord, adapter: AgentEngineAdapter): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    let eventWrites = Promise.resolve();
    try {
      run.status = "running";
      run.startedAt = new Date().toISOString();
      run.updatedAt = run.startedAt;
      await this.persist(run);
      await this.emit(run.id, "run.started", {
        agentId: run.agentId,
        engine: run.engine,
        workspace: run.workspace,
      });
      const result = await adapter.execute({
        runId: run.id,
        agentId: run.agentId,
        prompt: run.request.prompt,
        workspace: run.workspace?.path ?? run.request.workspace ?? process.cwd(),
        statePath: run.workspace?.statePath,
        sessionKey:
          run.request.freshSession === true
            ? `hibro-run-${run.id}`
            : run.request.options?.sessionId ??
              `hibro-${run.request.sessionKey || "default"}`,
        options: run.request.options,
        signal: controller.signal,
        requestApproval: (request) => this.requestApproval(run, request, controller.signal),
        onEvent: (type, payload) => {
          if (type === "session.started" && typeof payload.sessionId === "string") {
            run.sessionId = payload.sessionId;
          }
          eventWrites = eventWrites.then(() => this.emit(run.id, type, payload));
        },
      });
      await eventWrites;
      this.applySuccess(run, result);
      if (run.sessionId && run.agentId && run.request.sessionKey?.trim()) {
        this.sessions.set(this.sessionKey(run.agentId, run.request.sessionKey), run.sessionId);
      }
      await this.persist(run);
      await this.emit(run.id, "run.completed", {
        status: run.status,
        sessionId: run.sessionId,
      });
    } catch (error) {
      await eventWrites;
      const processError =
        error instanceof EngineProcessError
          ? error
          : new EngineProcessError(
              "internal_error",
              error instanceof Error ? error.message : String(error),
            );
      const wasCancelling =
        run.status === "cancelling" || processError.code === "cancelled";
      run.status =
        processError.code === "timeout"
          ? "timed_out"
          : wasCancelling
            ? "cancelled"
            : "failed";
      run.error = {
        code: processError.code,
        message: processError.message,
        details: processError.details,
      };
      run.finishedAt = new Date().toISOString();
      run.updatedAt = run.finishedAt;
      await this.persist(run);
      await this.emit(run.id, "run.failed", {
        status: run.status,
        error: run.error,
      });
    } finally {
      for (const [key, approval] of this.pendingApprovals) {
        if (approval.runId !== run.id) continue;
        this.pendingApprovals.delete(key);
        approval.resolve("deny");
      }
      this.controllers.delete(run.id);
      this.activeRuns.delete(run.id);
      if (run.agentId) {
        try {
          await this.workspaces.release(run.agentId, run.id, run.workspace);
        } catch (error) {
          await this.emit(run.id, "workspace.cleanup_failed", {
            message: error instanceof Error ? error.message : String(error),
            path: run.workspace?.path,
          }).catch(() => undefined);
        }
      }
    }
  }

  private async requestApproval(
    run: RunRecord,
    request: EngineApprovalRequest,
    signal: AbortSignal,
  ): Promise<EngineApprovalDecision> {
    const trustKey = this.approvalTrustKey(run.id, request);
    const trustedUntil = this.sessionApprovals.get(trustKey);
    if (trustedUntil && trustedUntil > Date.now()) return "allow_once";
    if (trustedUntil) this.sessionApprovals.delete(trustKey);
    const key = `${run.id}:${request.externalId}`;
    if (this.pendingApprovals.has(key)) {
      throw new Error(`Duplicate approval request: ${request.externalId}`);
    }
    await this.emit(run.id, "engine.approval.requested", {
      externalId: request.externalId,
      request,
    });
    return new Promise<EngineApprovalDecision>((resolvePromise) => {
      const finish = (decision: EngineApprovalDecision): void => {
        signal.removeEventListener("abort", abort);
        resolvePromise(decision);
      };
      const abort = (): void => {
        this.pendingApprovals.delete(key);
        finish("deny");
      };
      this.pendingApprovals.set(key, {
        runId: run.id,
        request,
        resolve: finish,
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private approvalTrustKey(runId: string, request: EngineApprovalRequest): string {
    const run = this.activeRuns.get(runId);
    return [
      run?.agentId ?? "unknown",
      run?.request.sessionKey?.trim() || runId,
      request.kind,
      request.toolName ?? "",
      request.command ?? request.title,
    ].join(":");
  }

  private applySuccess(run: RunRecord, result: EngineExecutionResult): void {
    run.status = "completed";
    run.result = result.result;
    if (result.sessionId) run.sessionId = result.sessionId;
    run.finishedAt = new Date().toISOString();
    run.updatedAt = run.finishedAt;
  }

  private async emit(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let sequence = this.sequences.get(runId);
    if (sequence === undefined) {
      const previous = await this.store.getEvents(runId);
      sequence = previous.at(-1)?.sequence ?? 0;
    }
    sequence += 1;
    this.sequences.set(runId, sequence);
    const event: RunEvent = {
      runId,
      sequence,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    await this.store.appendEvent(event);
    this.events.emit(runId, event);
    this.events.emit("*", event);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    for (const run of await this.store.list()) {
      const events = await this.store.getEvents(run.id);
      this.sequences.set(run.id, events.at(-1)?.sequence ?? 0);
      if (
        run.status === "queued" ||
        run.status === "running" ||
        run.status === "cancelling"
      ) {
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.updatedAt = run.finishedAt;
        run.error = {
          code: "node_restarted",
          message: "Hibro Node restarted before the run reached a terminal state",
        };
        await this.persist(run);
        await this.emit(run.id, "run.failed", {
          status: run.status,
          error: run.error,
          recovered: true,
        });
      }
    }
  }

  private validateInput(input: CreateRunInput): void {
    if (!input.prompt || !input.prompt.trim()) throw new Error("prompt is required");
    if (!this.agents && (!input.workspace || !input.workspace.trim())) {
      throw new Error("workspace is required");
    }
    if (
      input.options?.timeoutMs !== undefined &&
      (!Number.isFinite(input.options.timeoutMs) || input.options.timeoutMs <= 0)
    ) {
      throw new Error("timeoutMs must be a positive number");
    }
  }

  private resolveAgent(input: CreateRunInput): AgentDefinition {
    const configured = input.agentId
      ? this.agents?.get(input.agentId)
      : this.agents?.default();
    if (this.agents && !configured) {
      throw new Error(input.agentId ? `Agent not found: ${input.agentId}` : "agentId is required");
    }
    if (configured) return configured;
    const now = new Date().toISOString();
    return {
      id: "legacy-claude",
      name: "Claude Code",
      engine: "claude-code",
      enabled: true,
      source: { type: "local", path: resolve(input.workspace ?? process.cwd()) },
      workspace: { strategy: "persistent", access: "workspace-write" },
      maxConcurrency: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  private sessionKey(agentId: string, sessionKey?: string): string {
    if (!sessionKey?.trim()) throw new Error("sessionKey is required to resume a session");
    return `${agentId}:${sessionKey.trim()}`;
  }

  private reserveRunSlot(agent: AgentDefinition, globalLimit: number): void {
    if (this.activeRuns.size + this.pendingRunReservations >= globalLimit) {
      throw new Error(`Node is at its global concurrency limit (${globalLimit})`);
    }
    const agentActive = this.workspaces.activeRunIds(agent.id).length;
    const agentPending = this.pendingAgentReservations.get(agent.id) ?? 0;
    if (agentActive + agentPending >= agent.maxConcurrency) {
      throw new Error(`Agent is at its concurrency limit (${agent.maxConcurrency})`);
    }
    this.pendingRunReservations += 1;
    this.pendingAgentReservations.set(agent.id, agentPending + 1);
  }

  private releaseRunReservation(agentId: string): void {
    this.pendingRunReservations = Math.max(0, this.pendingRunReservations - 1);
    const remaining = (this.pendingAgentReservations.get(agentId) ?? 1) - 1;
    if (remaining > 0) this.pendingAgentReservations.set(agentId, remaining);
    else this.pendingAgentReservations.delete(agentId);
  }

  private effectiveRunOptions(
    input: CreateRunInput,
    agent: AgentDefinition,
    settings: SystemSettings,
    lease: NonNullable<RunRecord["workspace"]>,
    artifactPath: string,
    sessionId: string | undefined,
  ): NonNullable<CreateRunInput["options"]> {
    const requestedSandbox = input.options?.sandbox;
    const dangerousAllowed =
      settings.allowDangerousSandbox && agent.allowDangerousSandbox === true;
    const policySandbox = dangerousAllowed
      ? ("danger-full-access" as const)
      : lease.writable
        ? ("workspace-write" as const)
        : ("read-only" as const);
    const rank = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 } as const;
    if (requestedSandbox && rank[requestedSandbox] > rank[policySandbox]) {
      throw new Error(
        `Requested sandbox ${requestedSandbox} exceeds Agent policy ${policySandbox}`,
      );
    }
    if (
      input.options?.permissionMode === "bypassPermissions" &&
      !dangerousAllowed
    ) {
      throw new Error("bypassPermissions requires an Agent explicitly allowed to use danger-full-access");
    }
    const requestedTools = input.options?.allowedTools;
    if (requestedTools && agent.allowedTools) {
      const policyTools = new Set(agent.allowedTools);
      const disallowed = requestedTools.filter((tool) => !policyTools.has(tool));
      if (disallowed.length) {
        throw new Error(`Requested tools exceed Agent policy: ${disallowed.join(", ")}`);
      }
    }
    return {
      ...input.options,
      timeoutMs: input.options?.timeoutMs ?? settings.defaultTimeoutMs,
      sessionId,
      model: input.options?.model ?? agent.model,
      allowedTools: requestedTools ?? agent.allowedTools,
      appendSystemPrompt:
        [
          agent.instructions,
          input.options?.appendSystemPrompt,
          `Hibro 产物目录：${artifactPath}\n需要交付给用户预览或下载的文件，请写入该目录。不要把密钥、Token、环境变量或其他秘密写入产物。最终回复中简要列出生成的文件。`,
        ].filter(Boolean).join("\n\n") || undefined,
      sandbox: requestedSandbox ?? policySandbox,
    };
  }

  private async cachedDoctor(adapter: AgentEngineAdapter): Promise<EngineDoctorResult> {
    const cached = this.doctorCache.get(adapter.engineType);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await adapter.doctor();
    this.doctorCache.set(adapter.engineType, { value, expiresAt: Date.now() + 15_000 });
    return value;
  }

  private async persist(run: RunRecord): Promise<void> {
    const snapshot = structuredClone(run);
    const previous = this.stateWrites.get(run.id) ?? Promise.resolve();
    const next = previous.then(() => this.store.update(snapshot));
    this.stateWrites.set(run.id, next);
    try {
      await next;
    } finally {
      if (this.stateWrites.get(run.id) === next) this.stateWrites.delete(run.id);
    }
  }
}

function artifactType(path: string): {
  contentType: string;
  previewKind: NonNullable<ArtifactRecord["previewKind"]>;
  encoding: "utf8" | "base64";
} {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return { contentType: "text/markdown", previewKind: "markdown", encoding: "utf8" };
  }
  if (extension === ".json") {
    return { contentType: "application/json", previewKind: "json", encoding: "utf8" };
  }
  if ([".html", ".htm"].includes(extension)) {
    return { contentType: "text/html", previewKind: "html", encoding: "utf8" };
  }
  if (extension === ".pdf") {
    return { contentType: "application/pdf", previewKind: "pdf", encoding: "base64" };
  }
  const videos: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
  };
  if (videos[extension]) {
    return {
      contentType: videos[extension],
      previewKind: "video",
      encoding: "base64",
    };
  }
  const audio: Record<string, string> = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
  };
  if (audio[extension]) {
    return {
      contentType: audio[extension],
      previewKind: "audio",
      encoding: "base64",
    };
  }
  const images: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  if (images[extension]) {
    return {
      contentType: images[extension],
      previewKind: "image",
      encoding: "base64",
    };
  }
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".css",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".swift",
      ".sql",
      ".sh",
      ".yaml",
      ".yml",
      ".toml",
      ".xml",
    ].includes(extension)
  ) {
    return { contentType: "text/plain", previewKind: "code", encoding: "utf8" };
  }
  if ([".txt", ".csv", ".log"].includes(extension)) {
    return { contentType: "text/plain", previewKind: "text", encoding: "utf8" };
  }
  return {
    contentType: "application/octet-stream",
    previewKind: "unknown",
    encoding: "base64",
  };
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
