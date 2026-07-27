import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ClaudeCodeAdapter } from "../src/claude-code-adapter.ts";
import { FileAgentRegistry } from "../src/agent-registry.ts";
import type {
  AgentEngineAdapter,
  EngineExecuteInput,
} from "../src/engine-adapter.ts";
import { RunManager } from "../src/run-manager.ts";
import { FileRunStore } from "../src/storage.ts";

const executable = resolve("test/fixtures/fake-claude.mjs");
await chmod(executable, 0o755);

async function manager(): Promise<RunManager> {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-test-"));
  const instance = new RunManager({
    adapter: new ClaudeCodeAdapter({ executable }),
    store: new FileRunStore(root),
  });
  await instance.init();
  return instance;
}

async function managerAt(root: string): Promise<RunManager> {
  const instance = new RunManager({
    adapter: new ClaudeCodeAdapter({ executable }),
    store: new FileRunStore(root),
  });
  await instance.init();
  return instance;
}

test("persists a successful run and ordered events", async () => {
  const instance = await manager();
  const created = await instance.create({
    prompt: "hello",
    workspace: process.cwd(),
  });
  const terminal = await instance.waitForTerminal(created.id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.result, "ACK:hello");
  assert.ok(terminal.sessionId);
  const events = await instance.eventsAfter(created.id);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.ok(events.some((event) => event.type === "session.started"));
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("cancels an active run", async () => {
  const instance = await manager();
  const created = await instance.create({
    prompt: "WAIT",
    workspace: process.cwd(),
  });
  await instance.cancel(created.id);
  const terminal = await instance.waitForTerminal(created.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.error?.code, "cancelled");
});

test("enforces timeout", async () => {
  const instance = await manager();
  const created = await instance.create({
    prompt: "WAIT",
    workspace: process.cwd(),
    options: { timeoutMs: 25 },
  });
  const terminal = await instance.waitForTerminal(created.id);
  assert.equal(terminal.status, "timed_out");
  assert.equal(terminal.error?.code, "timeout");
});

test("passes a stored session ID to a continued run", async () => {
  const instance = await manager();
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const created = await instance.create({
    prompt: "continued",
    workspace: process.cwd(),
    options: { sessionId },
  });
  const terminal = await instance.waitForTerminal(created.id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.sessionId, sessionId);
  assert.equal(terminal.result, "ACK:continued");
});

test("direct runs do not share an implicit Agent session", async () => {
  const observedSessions: Array<string | undefined> = [];
  class SessionAdapter implements AgentEngineAdapter {
    readonly engineType = "claude-code" as const;
    async doctor() {
      return { installed: true, ready: true };
    }
    async execute(input: EngineExecuteInput) {
      observedSessions.push(input.options?.sessionId);
      return {
        sessionId: `session-${observedSessions.length}`,
        result: "ok",
      };
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hibro-session-isolation-"));
  const instance = new RunManager({
    adapter: new SessionAdapter(),
    store: new FileRunStore(root),
  });
  await instance.init();
  const first = await instance.create({
    prompt: "first user",
    workspace: process.cwd(),
  });
  await instance.waitForTerminal(first.id);
  const second = await instance.create({
    prompt: "second user",
    workspace: process.cwd(),
  });
  await instance.waitForTerminal(second.id);
  assert.deepEqual(observedSessions, [undefined, undefined]);
});

test("the same session key stays isolated between Run-level projects", async () => {
  const observedSessions: Array<string | undefined> = [];
  class SessionAdapter implements AgentEngineAdapter {
    readonly engineType = "claude-code" as const;
    async doctor() {
      return { installed: true, ready: true };
    }
    async execute(input: EngineExecuteInput) {
      observedSessions.push(input.options?.sessionId);
      return {
        sessionId: `session-${observedSessions.length}`,
        result: "ok",
      };
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hibro-project-session-"));
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await Promise.all([mkdir(projectA), mkdir(projectB)]);
  const instance = new RunManager({
    adapter: new SessionAdapter(),
    store: new FileRunStore(join(root, "store")),
  });
  await instance.init();
  for (const project of [projectA, projectB, projectA]) {
    const run = await instance.create({
      prompt: "continue",
      workspace: project,
      sessionKey: "same-name",
    });
    await instance.waitForTerminal(run.id);
  }
  assert.deepEqual(observedSessions, [undefined, undefined, "session-1"]);
});

test("recovers an interrupted run after node restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-recovery-test-"));
  const store = new FileRunStore(root);
  await store.init();
  const now = new Date().toISOString();
  const runId = randomUUID();
  await store.create({
    id: runId,
    engine: "claude-code",
    status: "running",
    request: { prompt: "interrupted", workspace: process.cwd() },
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  });
  await store.appendEvent({
    runId,
    sequence: 1,
    type: "run.started",
    timestamp: now,
    payload: {},
  });

  const restarted = await managerAt(root);
  const recovered = await restarted.get(runId);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.error?.code, "node_restarted");
  const events = await restarted.eventsAfter(runId);
  assert.equal(events.at(-1)?.sequence, 2);
  assert.equal(events.at(-1)?.type, "run.failed");
  assert.equal(events.at(-1)?.payload.recovered, true);
});

test("prunes only terminal runs older than the configured retention period", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-retention-test-"));
  const store = new FileRunStore(root);
  await store.init();
  const old = new Date("2025-01-01T00:00:00.000Z").toISOString();
  const runId = randomUUID();
  await store.create({
    id: runId,
    engine: "claude-code",
    status: "completed",
    request: { prompt: "expired", workspace: process.cwd() },
    result: "old output",
    createdAt: old,
    updatedAt: old,
    finishedAt: old,
  });

  const instance = await managerAt(root);
  assert.equal(await instance.get(runId), undefined);
});

test("a run pauses for approval and resumes after an operator decision", async () => {
  class ApprovalAdapter implements AgentEngineAdapter {
    readonly engineType = "claude-code" as const;
    async doctor() {
      return { installed: true, ready: true };
    }
    async execute(input: EngineExecuteInput) {
      const decision = await input.requestApproval?.({
        externalId: "approval-test-1",
        kind: "command",
        title: "执行测试命令",
        command: "printf safe",
      });
      return { result: `decision:${decision}` };
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hibro-approval-test-"));
  const instance = new RunManager({
    adapter: new ApprovalAdapter(),
    store: new FileRunStore(root),
  });
  await instance.init();
  const created = await instance.create({
    prompt: "approve",
    workspace: process.cwd(),
    options: { approvalPolicy: "strict" },
  });
  const deadline = Date.now() + 2_000;
  let requested = false;
  while (!requested && Date.now() < deadline) {
    requested = (await instance.eventsAfter(created.id)).some(
      (event) => event.type === "engine.approval.requested",
    );
    if (!requested) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(requested, true);
  await instance.decideApproval(created.id, "approval-test-1", "allow_once");
  const terminal = await instance.waitForTerminal(created.id);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.result, "decision:allow_once");
  assert.ok(
    (await instance.eventsAfter(created.id)).some(
      (event) =>
        event.type === "engine.approval.resolved" &&
        event.payload.decision === "allow_once",
    ),
  );
});

test("workspace approval policy auto-allows routine work but keeps risky commands gated", async () => {
  class PolicyAdapter implements AgentEngineAdapter {
    readonly engineType = "codex" as const;
    private readonly command: string;
    constructor(command: string) {
      this.command = command;
    }
    async doctor() {
      return { installed: true, ready: true };
    }
    async execute(input: EngineExecuteInput) {
      const decision = await input.requestApproval?.({
        externalId: `approval-${this.command}`,
        kind: "command",
        title: "执行命令",
        command: this.command,
        cwd: input.workspace,
      });
      return { result: `decision:${decision}` };
    }
  }

  const createManager = async (command: string) => {
    const root = await mkdtemp(join(tmpdir(), "hibro-policy-test-"));
    const agents = new FileAgentRegistry(join(root, "agents.json"));
    const instance = new RunManager({
      adapters: [new PolicyAdapter(command)],
      store: new FileRunStore(root),
      agents,
    });
    await instance.init();
    const agent = await agents.create({
      name: "Workspace Auto",
      engine: "codex",
      enabled: true,
      workspace: { strategy: "persistent", access: "workspace-write" },
      maxConcurrency: 1,
      approvalPolicy: "workspace",
    });
    return { instance, agent };
  };

  const routine = await createManager("npm test");
  const routineRun = await routine.instance.create({
    agentId: routine.agent.id,
    prompt: "test",
  });
  const routineTerminal = await routine.instance.waitForTerminal(routineRun.id);
  assert.equal(routineTerminal.result, "decision:allow_once");
  const routineEvents = await routine.instance.eventsAfter(routineRun.id);
  assert.equal(
    routineEvents.some((event) => event.type === "engine.approval.requested"),
    false,
  );
  assert.ok(
    routineEvents.some(
      (event) =>
        event.type === "engine.approval.resolved" &&
        event.payload.automatic === true &&
        event.payload.policy === "workspace",
    ),
  );

  const risky = await createManager("sudo systemctl restart hibro-core");
  const riskyRun = await risky.instance.create({
    agentId: risky.agent.id,
    prompt: "restart",
  });
  const deadline = Date.now() + 2_000;
  while (
    !(await risky.instance.eventsAfter(riskyRun.id)).some(
      (event) => event.type === "engine.approval.requested",
    ) &&
    Date.now() < deadline
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.ok(risky.instance.pendingApproval(
    riskyRun.id,
    "approval-sudo systemctl restart hibro-core",
  ));
  await risky.instance.decideApproval(
    riskyRun.id,
    "approval-sudo systemctl restart hibro-core",
    "deny",
  );
  const riskyTerminal = await risky.instance.waitForTerminal(riskyRun.id);
  assert.equal(riskyTerminal.result, "decision:deny");
});

test("unrestricted approval policy requires both Agent and Node dangerous switches", async () => {
  class ApprovalAdapter implements AgentEngineAdapter {
    readonly engineType = "codex" as const;
    async doctor() {
      return { installed: true, ready: true };
    }
    async execute(input: EngineExecuteInput) {
      const decision = await input.requestApproval?.({
        externalId: "dangerous-approval",
        kind: "network",
        title: "发布生产版本",
        command: "curl https://example.invalid/deploy",
        cwd: input.workspace,
      });
      return { result: `decision:${decision}` };
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hibro-unrestricted-test-"));
  const agents = new FileAgentRegistry(join(root, "agents.json"));
  const instance = new RunManager({
    adapters: [new ApprovalAdapter()],
    store: new FileRunStore(root),
    agents,
  });
  await instance.init();
  const agent = await agents.create({
    name: "Unrestricted",
    engine: "codex",
    enabled: true,
    workspace: { strategy: "persistent", access: "workspace-write" },
    maxConcurrency: 1,
    approvalPolicy: "unrestricted",
    allowDangerousSandbox: true,
  });

  await assert.rejects(
    () => instance.create({ agentId: agent.id, prompt: "deploy" }),
    /requires both Node and Agent danger-full-access switches/,
  );
  await instance.updateSettings({ allowDangerousSandbox: true });
  const run = await instance.create({ agentId: agent.id, prompt: "deploy" });
  const terminal = await instance.waitForTerminal(run.id);
  assert.equal(terminal.result, "decision:allow_once");
  assert.equal(
    (await instance.eventsAfter(run.id)).some(
      (event) => event.type === "engine.approval.requested",
    ),
    false,
  );
});

test("collects text and binary deliverables from the isolated artifact directory", async () => {
  class ArtifactAdapter implements AgentEngineAdapter {
    readonly engineType = "claude-code" as const;
    async doctor() {
      return { installed: true, ready: true };
    }
    async execute(input: EngineExecuteInput) {
      const match = input.options?.appendSystemPrompt?.match(
        /Hibro 产物目录：([^\n]+)/,
      );
      assert.ok(match?.[1]);
      await writeFile(join(match[1], "report.md"), "# Delivery\nComplete");
      await writeFile(
        join(match[1], "pixel.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      await writeFile(join(match[1], "clip.mp4"), Buffer.from("fake-mp4-payload"));
      return { result: "Created three deliverables" };
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hibro-artifact-test-"));
  const instance = new RunManager({
    adapter: new ArtifactAdapter(),
    store: new FileRunStore(root),
  });
  await instance.init();
  const run = await instance.create({
    prompt: "create artifacts",
    workspace: process.cwd(),
  });
  await instance.waitForTerminal(run.id);
  const artifacts = (await instance.listArtifacts()).filter(
    (artifact) => artifact.runId === run.id,
  );
  assert.equal(artifacts.length, 3);
  assert.equal(
    artifacts.some((artifact) => artifact.fileName === "agent-result.md"),
    false,
  );
  assert.equal(
    artifacts.find((artifact) => artifact.fileName === "report.md")?.previewKind,
    "markdown",
  );
  const image = artifacts.find((artifact) => artifact.fileName === "pixel.png");
  assert.ok(image);
  assert.equal(image?.previewKind, "image");
  assert.equal(image?.encoding, "base64");
  assert.match(image?.sha256 ?? "", /^[a-f0-9]{64}$/);
  const video = artifacts.find((artifact) => artifact.fileName === "clip.mp4");
  assert.equal(video?.previewKind, "video");
  assert.equal(video?.contentType, "video/mp4");
  assert.ok(video?.localPath);
  assert.equal(video?.content, undefined);
  assert.ok(artifacts.every((artifact) => artifact.sync?.status === "local_only"));

  await instance.updateSettings({
    coreEnabled: true,
    coreUrl: "ws://127.0.0.1:17400",
    coreToken: "enrollment-test-token",
  });
  const pending = (await instance.listArtifacts()).filter(
    (artifact) => artifact.runId === run.id,
  );
  assert.ok(pending.every((artifact) => artifact.sync?.status === "pending"));
  instance.setArtifactSync(image, "synced");
  assert.equal(
    (await instance.getArtifact(image.id))?.sync?.status,
    "synced",
  );
});
