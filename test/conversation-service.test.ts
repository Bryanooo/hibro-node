import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { FileAgentRegistry } from "../src/agent-registry.ts";
import { ConversationService } from "../src/conversation-service.ts";
import { ConversationStore } from "../src/conversation-store.ts";
import type {
  AgentEngineAdapter,
  EngineExecuteInput,
} from "../src/engine-adapter.ts";
import { RunManager } from "../src/run-manager.ts";
import { SqliteRunStore } from "../src/storage.ts";

class ActivityAdapter implements AgentEngineAdapter {
  readonly engineType = "claude-code" as const;

  async doctor() {
    return { installed: true, ready: true };
  }

  async execute(input: EngineExecuteInput) {
    input.onEvent?.("assistant.message", {
      message: {
        content: [
          { type: "thinking", thinking: "检查工作空间与依赖" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { path: "README.md" } },
        ],
      },
    });
    input.onEvent?.("engine.user_message", {
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "README content" },
        ],
      },
    });
    input.onEvent?.("engine.permission_request", {
      type: "permission_request",
      id: "approval-1",
      name: "Write",
      status: "pending",
    });
    input.onEvent?.("assistant.message", {
      message: { content: [{ type: "text", text: "已完成检查。" }] },
    });
    return {
      sessionId: "session-conversation-test",
      result: "已完成检查。",
    };
  }
}

test("conversation persists messages, engine activity and read-only approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-conversation-test-"));
  const agents = new FileAgentRegistry(join(root, "agents.json"), process.cwd());
  const manager = new RunManager({
    store: new SqliteRunStore(root),
    agents,
    adapters: [new ActivityAdapter()],
  });
  await manager.init();
  const service = new ConversationService(
    new ConversationStore(join(root, "hibro.db")),
    manager,
  );
  await service.init();
  const agent = agents.list().find((item) => item.engine === "claude-code");
  assert.ok(agent);

  const created = service.create({ agentId: agent.id, createdBy: "test-user" });
  const started = await service.sendMessage(created.conversation.id, {
    content: "检查项目",
  });
  assert.equal(started.conversation.status, "responding");
  assert.ok(started.conversation.activeRunId);
  await manager.waitForTerminal(started.conversation.activeRunId);
  await service.close();

  const reopened = new ConversationStore(join(root, "hibro.db"));
  await reopened.init();
  const detail = reopened.detail(created.conversation.id);
  assert.equal(detail?.conversation.status, "idle");
  assert.equal(detail?.messages.at(-1)?.content, "已完成检查。");
  assert.ok(detail?.activities.some((item) => item.type === "thinking"));
  assert.ok(detail?.activities.some((item) => item.type === "tool_call"));
  assert.ok(detail?.activities.some((item) => item.type === "tool_result"));
  const approval = detail?.activities.find((item) => item.type === "approval");
  assert.equal(approval?.approval?.resolvable, false);
  assert.ok(reopened.eventsAfter(created.conversation.id, 0).length >= 8);
  await reopened.close();
});

test("conversation reconciles an interrupted active run after Node restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-conversation-restart-"));
  const agents = new FileAgentRegistry(join(root, "agents.json"), process.cwd());
  await agents.init();
  const agent = agents.list().find((item) => item.engine === "claude-code");
  assert.ok(agent);
  const runId = randomUUID();
  const conversationId = `conv_${randomUUID()}`;
  const assistantMessageId = `msg_${randomUUID()}`;
  const now = new Date().toISOString();
  const runStore = new SqliteRunStore(root);
  await runStore.init();
  await runStore.create({
    id: runId,
    agentId: agent.id,
    engine: agent.engine,
    status: "running",
    request: {
      prompt: "interrupted conversation",
      agentId: agent.id,
      sessionKey: conversationId,
      metadata: {
        conversationId,
        assistantMessageId,
      },
    },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  });
  await runStore.appendEvent({
    runId,
    sequence: 1,
    type: "run.started",
    timestamp: now,
    payload: {},
  });
  const conversationStore = new ConversationStore(join(root, "hibro.db"));
  await conversationStore.init();
  conversationStore.create({
    id: conversationId,
    title: "Restart recovery",
    agentId: agent.id,
    engine: agent.engine,
    status: "responding",
    source: "node",
    createdBy: "test",
    activeRunId: runId,
    createdAt: now,
    updatedAt: now,
  });
  conversationStore.createMessage({
    id: assistantMessageId,
    conversationId,
    role: "assistant",
    content: "",
    status: "streaming",
    runId,
    createdAt: now,
    updatedAt: now,
  });
  await conversationStore.close();

  const restartedManager = new RunManager({
    store: new SqliteRunStore(root),
    agents: new FileAgentRegistry(join(root, "agents.json"), process.cwd()),
    adapters: [new ActivityAdapter()],
  });
  await restartedManager.init();
  const restartedService = new ConversationService(
    new ConversationStore(join(root, "hibro.db")),
    restartedManager,
  );
  await restartedService.init();
  const recovered = restartedService.detail(conversationId);
  assert.equal(recovered?.conversation.status, "error");
  assert.equal(recovered?.conversation.activeRunId, undefined);
  assert.equal(recovered?.messages[0]?.status, "failed");
  assert.match(recovered?.messages[0]?.error ?? "", /restarted/i);
  await restartedService.close();
});
