import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { migrateNodeDataLayout } from "../src/data-layout.ts";

test("Docker metadata and Agent homes consolidate beneath /data/.hibro", async () => {
  const volume = await mkdtemp(join(tmpdir(), "hibro-docker-layout-"));
  const home = join(volume, ".hibro");
  const oldAgent = join(volume, "agents", "agent-one");
  const oldState = join(oldAgent, ".hibro", "state");
  const oldWorkspace = join(oldAgent, "workspace");
  await createGitPointerFixture(oldState, oldWorkspace);
  await mkdir(join(oldAgent, "artifacts"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.json"), '{"nodeName":"docker"}\n');
  await writeFile(join(home, "agents.json"), "[]\n");
  await writeFile(join(home, "hibro.db"), "database");
  await writeFile(join(oldAgent, "artifacts", "report.md"), "keep me");

  const layout = await migrateNodeDataLayout(home);
  const agent = join(layout.agentsRoot, "agent-one");

  assert.equal(layout.root, resolve(home));
  assert.equal(await readFile(layout.settings, "utf8"), '{"nodeName":"docker"}\n');
  assert.equal(await readFile(join(agent, "artifacts", "report.md"), "utf8"), "keep me");
  await access(join(agent, "state", "source.git"));
  await assert.rejects(() => access(oldAgent));
  await assert.rejects(() => access(join(agent, ".hibro")));
  assert.equal(
    await readFile(join(agent, "workspace", ".git"), "utf8"),
    `gitdir: ${resolve(agent, "state", "source.git", "worktrees", "workspace")}\n`,
  );
  assert.equal(
    await readFile(
      join(agent, "state", "source.git", "worktrees", "workspace", "gitdir"),
      "utf8",
    ),
    `${resolve(agent, "workspace", ".git")}\n`,
  );

  await migrateNodeDataLayout(home);
  assert.equal(await readFile(layout.database, "utf8"), "database");
});

test("the native ~/.hibro default imports the previous ~/.hibro-node layout", async () => {
  const userHome = await mkdtemp(join(tmpdir(), "hibro-native-layout-"));
  const oldHome = join(userHome, ".hibro-node");
  const oldMetadata = join(oldHome, ".hibro");
  const oldAgent = join(oldHome, "agents", "agent-native");
  const oldState = join(oldAgent, ".hibro", "state");
  const oldWorkspace = join(oldAgent, "workspace");
  await createGitPointerFixture(oldState, oldWorkspace);
  await mkdir(oldMetadata, { recursive: true });
  await writeFile(join(oldMetadata, "settings.json"), '{"nodeName":"native"}\n');
  await writeFile(join(oldMetadata, "agents.json"), "[]\n");
  await writeFile(join(oldMetadata, "hibro.db"), "native-database");

  const layout = await migrateNodeDataLayout(join(userHome, ".hibro"));
  const agent = join(layout.agentsRoot, "agent-native");

  assert.equal(await readFile(layout.database, "utf8"), "native-database");
  assert.equal(await readFile(layout.settings, "utf8"), '{"nodeName":"native"}\n');
  await access(join(agent, "workspace"));
  await access(join(agent, "state", "source.git"));
  await assert.rejects(() => access(join(agent, ".hibro")));
  assert.equal(
    await readFile(join(agent, "workspace", ".git"), "utf8"),
    `gitdir: ${resolve(agent, "state", "source.git", "worktrees", "workspace")}\n`,
  );
});

async function createGitPointerFixture(
  state: string,
  workspace: string,
): Promise<void> {
  const worktree = join(state, "source.git", "worktrees", "workspace");
  await mkdir(worktree, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, ".git"),
    `gitdir: ${resolve(worktree)}\n`,
  );
  await writeFile(join(worktree, "gitdir"), `${resolve(workspace, ".git")}\n`);
}
