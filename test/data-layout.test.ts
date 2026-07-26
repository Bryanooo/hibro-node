import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { migrateNodeDataLayout } from "../src/data-layout.ts";

test("legacy global and Agent metadata moves into .hibro without touching user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-layout-"));
  const agentRoot = join(root, "agents", "agent-one");
  const oldState = join(agentRoot, "state");
  const workspace = join(agentRoot, "workspace");
  await mkdir(join(oldState, "source.git", "worktrees", "workspace"), {
    recursive: true,
  });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(agentRoot, "artifacts"), { recursive: true });
  await writeFile(join(root, "settings.json"), '{"nodeName":"legacy"}\n');
  await writeFile(join(root, "agents.json"), "[]\n");
  await writeFile(join(root, "hibro.db"), "database");
  await writeFile(join(agentRoot, "artifacts", "report.md"), "keep me");
  await writeFile(
    join(workspace, ".git"),
    `gitdir: ${resolve(oldState)}/source.git/worktrees/workspace\n`,
  );

  const layout = await migrateNodeDataLayout(root);

  assert.equal(await readFile(layout.settings, "utf8"), '{"nodeName":"legacy"}\n');
  assert.equal(await readFile(layout.agentsRegistry, "utf8"), "[]\n");
  assert.equal(await readFile(layout.database, "utf8"), "database");
  assert.equal(
    await readFile(join(agentRoot, "artifacts", "report.md"), "utf8"),
    "keep me",
  );
  assert.match(
    await readFile(join(workspace, ".git"), "utf8"),
    new RegExp(`${escapeRegExp(resolve(agentRoot, ".hibro", "state"))}/source\\.git`),
  );
  await access(join(agentRoot, ".hibro", "state", "source.git"));
  await assert.rejects(() => access(oldState));

  // The migration is idempotent.
  await migrateNodeDataLayout(root);
  assert.equal(await readFile(layout.database, "utf8"), "database");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
