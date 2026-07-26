import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { FileAgentRegistry } from "../src/agent-registry.ts";
import { WorkspaceBusyError, WorkspaceManager } from "../src/workspace-manager.ts";

const execFileAsync = promisify(execFile);

test("agent registry seeds isolated Claude and Codex agents and generates IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-agents-"));
  const path = join(root, "agents.json");
  const registry = new FileAgentRegistry(path, process.cwd());
  await registry.init();
  const defaults = registry.list();
  assert.deepEqual(
    Object.fromEntries(
      ["claude-code", "codex", "openclaw"].map((engine) => [
        engine,
        defaults.filter((agent) => agent.engine === engine).length,
      ]),
    ),
    { "claude-code": 2, codex: 2, openclaw: 2 },
  );
  assert.ok(
    defaults.every((agent) =>
      /^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        agent.id,
      ),
    ),
  );
  assert.ok(defaults.every((agent) => agent.workspace.strategy === "persistent"));

  const created = await registry.create({
    name: "Reviewer",
    engine: "codex",
    enabled: true,
    source: { type: "local", path: process.cwd() },
    workspace: { strategy: "persistent", access: "read-only" },
    maxConcurrency: 1,
  });
  assert.match(
    created.id,
    /^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const persisted = JSON.parse(await readFile(path, "utf8")) as Array<{ id: string }>;
  assert.ok(persisted.some((agent) => agent.id === created.id));
  assert.equal(await registry.delete(created.id), true);
  assert.equal(registry.get(created.id), undefined);
});

test("agent registry migrates legacy workspace fields without changing IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-agents-migration-"));
  const path = join(root, "agents.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        id: "claude-local",
        name: "Legacy Claude",
        engine: "claude-code",
        enabled: true,
        projectRoot: process.cwd(),
        workspaceMode: "shared-readonly",
        maxConcurrency: 1,
      },
      {
        id: "codex-local",
        name: "Legacy Codex",
        engine: "codex",
        enabled: true,
        projectRoot: process.cwd(),
        workspaceMode: "ephemeral-worktree",
        maxConcurrency: 1,
      },
    ]),
    "utf8",
  );
  const registry = new FileAgentRegistry(path);
  await registry.init();
  const claude = registry.get("claude-local");
  const codex = registry.get("codex-local");
  assert.deepEqual(claude?.workspace, { strategy: "persistent", access: "read-only" });
  assert.deepEqual(codex?.workspace, { strategy: "per-run", access: "workspace-write" });
  assert.equal(claude?.source.path, process.cwd());
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, /projectRoot|workspaceMode/);
});

test("workspace manager prevents concurrent writable use by one agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-workspaces-"));
  const manager = new WorkspaceManager(root);
  const now = new Date().toISOString();
  const agent = {
    id: "writer",
    name: "Writer",
    engine: "codex" as const,
    enabled: true,
    source: { type: "local" as const, path: process.cwd() },
    workspace: { strategy: "persistent" as const, access: "workspace-write" as const },
    maxConcurrency: 2,
    createdAt: now,
    updatedAt: now,
  };
  const first = await manager.acquire(agent, "run-1");
  await assert.rejects(() => manager.acquire(agent, "run-2"), WorkspaceBusyError);
  await manager.release(agent.id, "run-1", first);
  const second = await manager.acquire(agent, "run-2");
  assert.equal(second.path, join(root, agent.id, "workspace"));
  assert.notEqual(second.path, process.cwd());
  await manager.release(agent.id, "run-2", second);
});

test("workspace manager creates, reuses and cleans isolated workspace strategies", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-workspace-modes-"));
  const projectRoot = join(root, "project");
  const workspaceRoot = join(root, "leases");
  await execFileAsync("git", ["init", projectRoot]);
  await writeFile(join(projectRoot, "README.md"), "workspace fixture\n", "utf8");
  await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=Hibro Test",
    "-c",
    "user.email=hibro@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  const manager = new WorkspaceManager(workspaceRoot);
  const now = new Date().toISOString();
  const baseAgent = {
    id: "isolated",
    name: "Isolated",
    engine: "codex" as const,
    enabled: true,
    source: { type: "local" as const, path: projectRoot },
    workspace: { strategy: "persistent" as const, access: "workspace-write" as const },
    maxConcurrency: 1,
    createdAt: now,
    updatedAt: now,
  };

  const scratch = await manager.acquire(
    { ...baseAgent, workspace: { strategy: "scratch", access: "workspace-write" } },
    "scratch-run",
  );
  await access(scratch.path);
  await manager.release(baseAgent.id, "scratch-run", scratch);
  await assert.rejects(() => access(scratch.path));

  const persistentAgent = {
    ...baseAgent,
    workspace: { strategy: "persistent" as const, access: "workspace-write" as const },
  };
  const persistent = await manager.acquire(persistentAgent, "persistent-1");
  await manager.release(baseAgent.id, "persistent-1", persistent);
  const persistentAgain = await manager.acquire(persistentAgent, "persistent-2");
  assert.equal(persistentAgain.path, persistent.path);
  await manager.release(baseAgent.id, "persistent-2", persistentAgain);
  await access(persistent.path);

  const ephemeral = await manager.acquire(
    {
      ...baseAgent,
      id: "ephemeral",
      workspace: { strategy: "per-run", access: "workspace-write" },
    },
    "ephemeral-run",
  );
  await access(ephemeral.path);
  await manager.release("ephemeral", "ephemeral-run", ephemeral);
  await assert.rejects(() => access(ephemeral.path));
});

test("agents sharing one source still receive different private workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-private-workspaces-"));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "README.md"), "shared source\n", "utf8");
  const manager = new WorkspaceManager(join(root, "agents"));
  const now = new Date().toISOString();
  const definition = {
    name: "Agent",
    engine: "codex" as const,
    enabled: true,
    source: { type: "local" as const, path: source },
    workspace: { strategy: "persistent" as const, access: "workspace-write" as const },
    maxConcurrency: 1,
    createdAt: now,
    updatedAt: now,
  };
  const firstAgent = { ...definition, id: "agent-one" };
  const secondAgent = { ...definition, id: "agent-two" };
  const first = await manager.acquire(firstAgent, "run-one");
  const second = await manager.acquire(secondAgent, "run-two");
  assert.notEqual(first.path, second.path);
  assert.equal(first.sourcePath, second.sourcePath);
  assert.match(first.path, /agent-one\/workspace$/);
  assert.match(second.path, /agent-two\/workspace$/);
  await manager.release(firstAgent.id, "run-one", first);
  await manager.release(secondAgent.id, "run-two", second);
});

test("Git workspaces keep source metadata read-only and manage worktrees in Agent state", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-readonly-source-"));
  const projectRoot = join(root, "readonly-project");
  const workspaceRoot = join(root, "agents");
  await execFileAsync("git", ["init", projectRoot]);
  await writeFile(join(projectRoot, "README.md"), "read-only source\n", "utf8");
  await execFileAsync("git", ["-C", projectRoot, "add", "README.md"]);
  await execFileAsync("git", [
    "-C",
    projectRoot,
    "-c",
    "user.name=Hibro Test",
    "-c",
    "user.email=hibro@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await chmod(join(projectRoot, ".git"), 0o555);

  const manager = new WorkspaceManager(workspaceRoot);
  const now = new Date().toISOString();
  const agent = {
    id: "readonly-git-agent",
    name: "Read-only Git Agent",
    engine: "codex" as const,
    enabled: true,
    source: { type: "local" as const, path: projectRoot },
    workspace: {
      strategy: "per-run" as const,
      access: "workspace-write" as const,
    },
    maxConcurrency: 2,
    createdAt: now,
    updatedAt: now,
  };

  const [lease, concurrentLease] = await Promise.all([
    manager.acquire(agent, "readonly-run"),
    manager.acquire(agent, "readonly-run-2"),
  ]);
  assert.equal(lease.materialization, "git-worktree");
  assert.equal(concurrentLease.materialization, "git-worktree");
  assert.equal(
    lease.gitRepositoryPath,
    join(workspaceRoot, agent.id, "state", "source.git"),
  );
  await access(join(lease.path, "README.md"));
  await access(join(concurrentLease.path, "README.md"));
  await assert.rejects(() => access(join(projectRoot, ".git", "worktrees")));
  await Promise.all([
    manager.release(agent.id, "readonly-run", lease),
    manager.release(agent.id, "readonly-run-2", concurrentLease),
  ]);
  await Promise.all([
    assert.rejects(() => access(lease.path)),
    assert.rejects(() => access(concurrentLease.path)),
  ]);
});
