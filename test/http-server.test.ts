import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { FileAgentRegistry } from "../src/agent-registry.ts";
import { ClaudeCodeAdapter } from "../src/claude-code-adapter.ts";
import { createHibroHttpServer, listen } from "../src/http-server.ts";
import { RunManager } from "../src/run-manager.ts";
import { FileRunStore } from "../src/storage.ts";
import { WorkspaceManager } from "../src/workspace-manager.ts";

const executable = resolve("test/fixtures/fake-claude.mjs");
await chmod(executable, 0o755);

test("HTTP API creates and returns a run", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-http-test-"));
  const manager = new RunManager({
    adapter: new ClaudeCodeAdapter({ executable }),
    store: new FileRunStore(root),
  });
  await manager.init();
  const server = createHibroHttpServer({
    host: "127.0.0.1",
    port: 0,
    manager,
  });
  context.after(() => server.close());
  const address = await listen(server, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as {
    status: string;
    hostname: string;
    cwd: string;
  };
  assert.equal(healthBody.status, "ok");
  assert.ok(healthBody.hostname);
  assert.equal(healthBody.cwd, process.cwd());

  const settingsWithoutLogin = await fetch(`${base}/v1/settings`);
  assert.equal(settingsWithoutLogin.status, 200);
  const removedLoginPage = await fetch(`${base}/login`);
  assert.equal(removedLoginPage.status, 404);

  const consolePage = await fetch(`${base}/console`);
  assert.equal(consolePage.status, 200);
  assert.match(consolePage.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await consolePage.text(), /Hibro Node Console/);
  const consoleHtml = await (await fetch(`${base}/console`)).text();
  assert.match(consoleHtml, /data-close-dialog="run-dialog"/);
  assert.match(consoleHtml, /id="new-agent-button"/);
  assert.match(consoleHtml, /id="settings-form"/);
  assert.match(consoleHtml, /默认项目目录（可选）/);
  assert.match(consoleHtml, /Agent 专属空间/);

  const consoleCss = await fetch(`${base}/console/styles.css`);
  assert.equal(consoleCss.status, 200);
  assert.match(consoleCss.headers.get("content-type") ?? "", /text\/css/);

  const consoleJs = await fetch(`${base}/console/app.js`);
  assert.equal(consoleJs.status, 200);
  const consoleScript = await consoleJs.text();
  assert.match(consoleScript, /events\?format=json/);
  assert.match(consoleScript, /默认项目（只用于创建工作副本）/);
  assert.match(consoleScript, /Agent 专属空间（实际工作位置）/);

  const brand = await fetch(`${base}/console/hibro-mark.png`);
  assert.equal(brand.status, 200);
  assert.equal(brand.headers.get("content-type"), "image/png");
  assert.ok((await brand.arrayBuffer()).byteLength > 1_000);

  const response = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "api", workspace: process.cwd() }),
  });
  assert.equal(response.status, 202);
  const created = (await response.json()) as { id: string };
  const terminal = await manager.waitForTerminal(created.id);
  assert.equal(terminal.status, "completed");

  const artifactsResponse = await fetch(`${base}/v1/artifacts`);
  const artifacts = (await artifactsResponse.json()) as {
    artifacts: Array<{ runId: string; content: string }>;
  };
  assert.deepEqual(artifacts.artifacts, []);

  const artifactDownload = await fetch(`${base}/v1/artifacts/${created.id}/download`);
  assert.equal(artifactDownload.status, 404);

  const settingsResponse = await fetch(`${base}/v1/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeName: "HTTP Test Node", maxConcurrentRuns: 3 }),
  });
  assert.equal(settingsResponse.status, 200);
  const settings = (await settingsResponse.json()) as {
    nodeName: string;
    maxConcurrentRuns: number;
  };
  assert.equal(settings.nodeName, "HTTP Test Node");
  assert.equal(settings.maxConcurrentRuns, 3);

  const systemResponse = await fetch(`${base}/v1/system`);
  assert.equal(systemResponse.status, 200);
  const system = (await systemResponse.json()) as {
    nodeVersion: string;
    hibroVersion: string;
    dataDir: string;
  };
  assert.match(system.nodeVersion, /^v/);
  assert.equal(system.hibroVersion, "0.2.0");
  assert.equal(system.dataDir, root);

  const protocolResponse = await fetch(`${base}/v1/protocol`);
  assert.equal(protocolResponse.status, 200);
  const protocol = (await protocolResponse.json()) as {
    protocol: string;
    canonicalTransport: string;
    messageTypes: string[];
    runtimeTransportImplemented: boolean;
  };
  assert.equal(protocol.protocol, "hibro.node.v1");
  assert.equal(protocol.canonicalTransport, "wss");
  assert.ok(protocol.messageTypes.includes("agent.registration"));
  assert.equal(protocol.runtimeTransportImplemented, true);

  const fetched = await fetch(`${base}/v1/runs/${created.id}`);
  const run = (await fetched.json()) as { result: string };
  assert.equal(run.result, "ACK:api");

  const eventResponse = await fetch(`${base}/v1/runs/${created.id}/events`);
  assert.equal(eventResponse.status, 200);
  assert.match(eventResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const eventBody = await eventResponse.text();
  const events = eventBody
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { sequence: number; type: string });
  assert.ok(events.length >= 5);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, index) => index + 1),
  );
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("Agent API generates IDs, exposes private paths and reports Core registration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-agent-api-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "README.md"), "agent source\n", "utf8");
  const registry = new FileAgentRegistry(join(root, "agents.json"), source);
  const manager = new RunManager({
    adapter: new ClaudeCodeAdapter({ executable }),
    store: new FileRunStore(root),
    agents: registry,
    workspaces: new WorkspaceManager(join(root, "agents")),
  });
  await manager.init();
  const server = createHibroHttpServer({
    host: "127.0.0.1",
    port: 0,
    manager,
  });
  context.after(() => server.close());
  const address = await listen(server, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${address.port}`;

  const createdResponse = await fetch(`${base}/v1/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "client-supplied-id-is-ignored",
      name: "API Reviewer",
      engine: "claude-code",
      source: { type: "local", path: source },
      workspace: { strategy: "persistent", access: "read-only" },
      maxConcurrency: 1,
      approvalPolicy: "workspace",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as {
    id: string;
    approvalPolicy: string;
  };
  assert.match(
    created.id,
    /^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(created.id, "client-supplied-id-is-ignored");
  assert.equal(created.approvalPolicy, "workspace");

  const clearedResponse = await fetch(`${base}/v1/agents/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: null }),
  });
  assert.equal(clearedResponse.status, 200);
  const cleared = (await clearedResponse.json()) as { source?: unknown };
  assert.equal(cleared.source, undefined);

  const restoredResponse = await fetch(`${base}/v1/agents/${created.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { type: "local", path: source } }),
  });
  assert.equal(restoredResponse.status, 200);

  const attachedRunResponse = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: created.id,
      prompt: "run project",
      source: { type: "local", path: source },
    }),
  });
  assert.equal(attachedRunResponse.status, 202);
  const attachedRun = (await attachedRunResponse.json()) as {
    id: string;
    workspace: { path: string; strategy: string; sourcePath: string };
  };
  assert.equal(attachedRun.workspace.strategy, "per-run");
  assert.equal(attachedRun.workspace.sourcePath, source);
  assert.match(attachedRun.workspace.path, new RegExp(`/runs/${attachedRun.id}/workspace$`));
  await manager.waitForTerminal(attachedRun.id);

  const elevatedRun = await fetch(`${base}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: created.id,
      prompt: "must remain read only",
      options: {
        sandbox: "workspace-write",
        allowedTools: ["Bash"],
      },
    }),
  });
  assert.equal(elevatedRun.status, 400);
  assert.match(
    JSON.stringify(await elevatedRun.json()),
    /exceeds Agent policy/,
  );

  const crossOriginMutation = await fetch(`${base}/v1/agents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://attacker.example",
    },
    body: "{}",
  });
  assert.equal(crossOriginMutation.status, 403);

  const agentsResponse = await fetch(`${base}/v1/agents`);
  const standalone = (await agentsResponse.json()) as {
    agents: Array<{
      agent: { id: string; source: { path: string } };
      coreRegistration: { status: string };
      paths: { workspace: string };
    }>;
  };
  const createdRuntime = standalone.agents.find((value) => value.agent.id === created.id);
  assert.equal(createdRuntime?.coreRegistration.status, "standalone");
  assert.equal(createdRuntime?.agent.source.path, source);
  assert.equal(createdRuntime?.paths.workspace, join(root, "agents", created.id, "workspace"));

  const defaults = standalone.agents.filter((value) => value.agent.id !== created.id);
  assert.ok(defaults.length >= 2);
  assert.equal(new Set(defaults.map((value) => value.paths.workspace)).size, defaults.length);

  const workspaceBody = (await (await fetch(`${base}/v1/workspaces`)).json()) as {
    workspaces: Array<{ agentId: string; path: string; sourcePath: string }>;
  };
  assert.equal(
    new Set(workspaceBody.workspaces.map((value) => value.path)).size,
    workspaceBody.workspaces.length,
  );
  const createdWorkspace = workspaceBody.workspaces.find(
    (value) => value.agentId === created.id,
  );
  assert.equal(createdWorkspace?.sourcePath, source);
  assert.ok(
    workspaceBody.workspaces
      .filter((value) => value.agentId !== created.id)
      .every((value) => value.sourcePath === undefined),
  );

  const settingsResponse = await fetch(`${base}/v1/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      coreEnabled: true,
      coreUrl: "ws://host.docker.internal:7332",
      coreToken: "test-token",
    }),
  });
  assert.equal(settingsResponse.status, 200);
  const pending = (await (await fetch(`${base}/v1/agents`)).json()) as {
    agents: Array<{ coreRegistration: { status: string; error?: string } }>;
  };
  assert.ok(pending.agents.every((value) => value.coreRegistration.status === "pending"));
  assert.match(pending.agents[0]?.coreRegistration.error ?? "", /正在连接/);
});
