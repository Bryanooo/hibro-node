import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EngineProviderRegistry,
  type AgentEngineAdapter,
  type EngineExecuteInput,
} from "../src/engine-adapter.ts";
import { NodeObservabilityService } from "../src/observability-service.ts";
import { RunManager } from "../src/run-manager.ts";
import { FileRunStore } from "../src/storage.ts";

test("Node preserves a Core trace and redacts structured engine events", async () => {
  class ObservableAdapter implements AgentEngineAdapter {
    readonly engineType = "claude-code" as const;
    async doctor() { return { installed: true, ready: true }; }
    async execute(input: EngineExecuteInput) {
      input.onEvent?.("tool.started", {
        toolName: "market-data",
        apiToken: "node-secret",
        nested: { authorization: "Bearer nested-secret" },
        message: "password=inline-secret",
      });
      return { result: "done" };
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hibro-node-observability-"));
  const manager = new RunManager({
    adapter: new ObservableAdapter(),
    store: new FileRunStore(root),
  });
  try {
    await manager.init();
    const created = await manager.create({
      prompt: "observe",
      workspace: process.cwd(),
      metadata: {
        trace: {
          traceId: "trace_core_observability",
          rootSpanId: "span_core_observability",
          parentSpanId: "span_team_observability",
        },
      },
    });
    const terminal = await manager.waitForTerminal(created.id);
    assert.equal(terminal.trace?.traceId, "trace_core_observability");
    const events = await manager.eventsAfter(created.id);
    assert.ok(events.every((event) => event.traceId === "trace_core_observability"));
    assert.ok(events.every((event) => event.spanId?.startsWith("span_")));
    const tool = events.find((event) => event.type === "tool.started");
    assert.equal(tool?.category, "tool");
    assert.equal(tool?.severity, "info");
    assert.equal(tool?.payload.apiToken, "[redacted]");
    assert.doesNotMatch(JSON.stringify(events), /node-secret|nested-secret|inline-secret/);

    const observability = new NodeObservabilityService(manager);
    const trace = await observability.trace(created.id);
    assert.equal(trace?.traceId, "trace_core_observability");
    assert.equal((trace?.spans as unknown[]).length, events.length + 1);
    assert.equal(trace?.toolCalls, 1);
    const overview = await observability.overview(7);
    assert.equal((overview.runs as { completed: number }).completed, 1);
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("engine providers are replaceable and reject ambiguous duplicates", () => {
  const registry = new EngineProviderRegistry<{ marker: string }>();
  registry.register({
    id: "codex",
    version: "test-1",
    capabilities: ["jsonl", "approval"],
    create: (context) => ({
      engineType: "codex",
      async doctor() { return { installed: true, ready: context.marker === "ready" }; },
      async execute() { return { result: context.marker }; },
    }),
  });
  assert.deepEqual(registry.catalog(), [{
    id: "codex",
    version: "test-1",
    capabilities: ["jsonl", "approval"],
  }]);
  assert.equal(registry.createAll({ marker: "ready" })[0]?.engineType, "codex");
  assert.throws(() => registry.register({
    id: "codex",
    version: "test-2",
    capabilities: [],
    create: () => { throw new Error("must not create"); },
  }), /already registered/);
});
