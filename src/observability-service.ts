import { createHash } from "node:crypto";
import type { ArtifactRecord, RunEvent, RunRecord } from "./domain.ts";
import type { RunManager } from "./run-manager.ts";
import { eventCategory, eventSeverity, sanitizeObservabilityPayload } from "./observability.ts";

export class NodeObservabilityService {
  private readonly manager: RunManager;

  constructor(manager: RunManager) {
    this.manager = manager;
  }

  async overview(windowDays = 7): Promise<Record<string, unknown>> {
    const days = clampDays(windowDays);
    const since = Date.now() - days * 86_400_000;
    const [runs, artifacts, agents] = await Promise.all([
      this.manager.list(),
      this.manager.listArtifacts(),
      this.manager.listAgents(),
    ]);
    const windowRuns = runs.filter((run) => Date.parse(run.createdAt) >= since);
    const terminal = windowRuns.filter((run) => isTerminal(run.status));
    const completed = terminal.filter((run) => run.status === "completed");
    return {
      windowDays: days,
      generatedAt: new Date().toISOString(),
      mode: this.manager.getSettings().coreEnabled ? "connected" : "standalone",
      runs: {
        total: windowRuns.length,
        active: windowRuns.filter((run) => !isTerminal(run.status)).length,
        completed: completed.length,
        failed: terminal.filter((run) => run.status === "failed" || run.status === "timed_out").length,
        successRate: terminal.length ? completed.length / terminal.length : null,
      },
      agents: { total: agents.length, running: agents.filter((agent) => agent.status === "running").length },
      artifacts: artifacts.filter((artifact) => windowRuns.some((run) => run.id === artifact.runId)).length,
      core: this.manager.getCoreConnection(),
    };
  }

  async traces(input: { agentId?: string; status?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const [runs, artifacts, agents] = await Promise.all([
      this.manager.list(),
      this.manager.listArtifacts(),
      this.manager.listAgents(),
    ]);
    const names = new Map(agents.map((runtime) => [runtime.agent.id, runtime.agent.name]));
    const limit = Math.min(500, Math.max(1, input.limit ?? 100));
    return Promise.all(runs
      .filter((run) => (!input.agentId || run.agentId === input.agentId) && (!input.status || run.status === input.status))
      .slice(0, limit)
      .map(async (run) => summary(
        run,
        await this.manager.eventsAfter(run.id),
        artifacts.filter((artifact) => artifact.runId === run.id),
        names.get(run.agentId ?? "") ?? run.agentId ?? run.engine,
      )));
  }

  async trace(runId: string): Promise<Record<string, unknown> | undefined> {
    const run = await this.manager.get(runId);
    if (!run) return undefined;
    const [events, artifacts] = await Promise.all([
      this.manager.eventsAfter(runId),
      this.manager.listArtifacts(),
    ]);
    const runtime = run.agentId ? (await this.manager.listAgents()).find((item) => item.agent.id === run.agentId) : undefined;
    const runArtifacts = artifacts.filter((artifact) => artifact.runId === run.id);
    const rootSpanId = run.trace?.rootSpanId ?? deterministicId("span", `${run.id}:root`);
    const safeEvents = events.map((event) => ({
      ...event,
      payload: sanitizeObservabilityPayload(event.payload),
    }));
    return {
      ...summary(run, safeEvents, runArtifacts, runtime?.agent.name ?? run.agentId ?? run.engine),
      rootSpanId,
      run,
      spans: [
        {
          spanId: rootSpanId,
          kind: "run",
          name: `Run · ${runtime?.agent.name ?? run.agentId ?? run.engine}`,
          status: run.status === "completed" ? "ok" : run.status === "failed" || run.status === "timed_out" ? "error" : "unset",
          startedAt: run.startedAt ?? run.createdAt,
          finishedAt: run.finishedAt,
          durationMs: duration(run),
        },
        ...safeEvents.map((event) => ({
          spanId: event.spanId ?? deterministicId("span", `${run.id}:${event.sequence}`),
          parentSpanId: event.parentSpanId ?? rootSpanId,
          kind: event.category ?? eventCategory(event.type),
          name: event.type,
          status: (event.severity ?? eventSeverity(event.type)) === "error" ? "error" : "unset",
          startedAt: event.timestamp,
          finishedAt: event.timestamp,
          durationMs: 0,
          sequence: event.sequence,
          severity: event.severity ?? eventSeverity(event.type),
          attributes: event.payload,
        })),
      ],
      events: safeEvents,
      artifacts: runArtifacts,
    };
  }

  async agentMetrics(agentId: string, windowDays = 30): Promise<Record<string, unknown> | undefined> {
    const runtime = (await this.manager.listAgents()).find((item) => item.agent.id === agentId);
    if (!runtime) return undefined;
    const days = clampDays(windowDays);
    const since = Date.now() - days * 86_400_000;
    const runs = (await this.manager.list()).filter((run) => run.agentId === agentId && Date.parse(run.createdAt) >= since);
    const terminal = runs.filter((run) => isTerminal(run.status));
    const completed = terminal.filter((run) => run.status === "completed");
    return {
      agent: runtime,
      windowDays: days,
      runs: {
        total: runs.length,
        active: runs.filter((run) => !isTerminal(run.status)).length,
        completed: completed.length,
        failed: terminal.length - completed.length,
        successRate: terminal.length ? completed.length / terminal.length : null,
        averageDurationMs: terminal.length
          ? Math.round(terminal.reduce((total, run) => total + duration(run), 0) / terminal.length)
          : 0,
      },
      recentTraces: (await this.traces({ agentId, limit: 20 })),
    };
  }

  async artifactLineage(artifactId: string): Promise<Record<string, unknown> | undefined> {
    const artifact = await this.manager.getArtifact(artifactId);
    if (!artifact) return undefined;
    const run = await this.manager.get(artifact.runId);
    return {
      artifact,
      producedBy: run ? {
        runId: run.id,
        traceId: run.trace?.traceId ?? deterministicId("trace", run.id),
        agentId: run.agentId,
        engine: run.engine,
        origin: run.origin,
        workspace: run.workspace?.path,
        createdAt: run.createdAt,
      } : null,
      synchronization: artifact.sync ?? { status: "local_only", synced: false },
    };
  }
}

function summary(run: RunRecord, events: RunEvent[], artifacts: ArtifactRecord[], agentName: string): Record<string, unknown> {
  return {
    traceId: run.trace?.traceId ?? deterministicId("trace", run.id),
    runId: run.id,
    agentId: run.agentId,
    agentName,
    engine: run.engine,
    status: run.status,
    prompt: run.request.prompt,
    origin: run.origin,
    startedAt: run.startedAt ?? run.createdAt,
    finishedAt: run.finishedAt,
    durationMs: duration(run),
    eventCount: events.length,
    toolCalls: events.filter((event) => (event.category ?? eventCategory(event.type)) === "tool").length,
    approvals: events.filter((event) => event.type.includes("approval.requested")).length,
    errors: events.filter((event) => (event.severity ?? eventSeverity(event.type)) === "error").length,
    artifactCount: artifacts.length,
  };
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function duration(run: RunRecord): number {
  return Math.max(0, Date.parse(run.finishedAt ?? run.updatedAt) - Date.parse(run.startedAt ?? run.createdAt));
}

function isTerminal(status: RunRecord["status"]): boolean {
  return ["completed", "failed", "cancelled", "timed_out"].includes(status);
}

function clampDays(value: number): number {
  return Math.min(365, Math.max(1, Number.isFinite(value) ? Math.round(value) : 7));
}
