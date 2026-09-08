import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentPackageManager,
  agentPackageHash,
  readAgentPackage,
  validateAgentPackage,
  type AgentPackageBundle,
} from "../src/agent-package.ts";
import { FileAgentRegistry } from "../src/agent-registry.ts";

function bundle(
  engine: "codex" | "claude-code" | "openclaw" = "codex",
  instructions = "You are a careful analyst.\n",
): AgentPackageBundle {
  return {
    manifest: {
      apiVersion: "hibro.ai/v1alpha1",
      kind: "Agent",
      metadata: { name: "Market Analyst", slug: "market-analyst" },
      spec: {
        engine,
        modalities: ["text", "image"],
        instructions: "instructions.md",
        skills: [{ name: "market-data", path: "skills/market-data" }],
        workspace: { strategy: "persistent", access: "workspace-write" },
        approvalPolicy: "workspace",
        maxConcurrency: 1,
      },
    },
    files: {
      "instructions.md": instructions,
      "skills/market-data/SKILL.md": "# Market data\nUse verified sources.\n",
      "skills/market-data/reference.md": "Reference\n",
    },
  };
}

test("Agent package validation is deterministic and rejects unsafe paths", () => {
  const first = bundle();
  const reordered: AgentPackageBundle = {
    manifest: structuredClone(first.manifest),
    files: {
      "skills/market-data/reference.md": "Reference\r\n",
      "skills/market-data/SKILL.md": "# Market data\r\nUse verified sources.\r\n",
      "instructions.md": "You are a careful analyst.\r\n",
    },
  };
  assert.equal(agentPackageHash(first), agentPackageHash(reordered));
  assert.throws(
    () => validateAgentPackage({ ...first, files: { ...first.files, "../secret": "x" } }),
    /normalized relative path/,
  );
  assert.throws(
    () => validateAgentPackage({ ...first, files: { "instructions.md": "x" } }),
    /missing SKILL.md/,
  );
  assert.throws(
    () => validateAgentPackage({ ...first, files: { ...first.files, "large.txt": "x".repeat(256 * 1024 + 1) } }),
    /exceeds 256 KiB/,
  );
  assert.throws(
    () => validateAgentPackage({
      ...first,
      manifest: { ...first.manifest, spec: { ...first.manifest.spec, engine: "unknown" } },
    }),
    /unsupported engine/,
  );
  assert.deepEqual(validateAgentPackage(first).manifest.spec.modalities, ["text", "image"]);
  assert.throws(
    () => validateAgentPackage({
      ...first,
      manifest: { ...first.manifest, spec: { ...first.manifest.spec, modalities: ["text", "hologram" as never] } },
    }),
    /unsupported value/,
  );
});

test("local Agent package import rejects symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-agent-source-"));
  await writeFile(
    join(root, "agent.yaml"),
    `apiVersion: hibro.ai/v1alpha1\nkind: Agent\nmetadata:\n  name: Local Agent\n  slug: local-agent\nspec:\n  engine: codex\n  instructions: instructions.md\n`,
  );
  await writeFile(join(root, "instructions.md"), "Local instructions\n");
  await symlink(join(root, "instructions.md"), join(root, "linked.md"));
  await assert.rejects(() => readAgentPackage(root), /symbolic links are not allowed/);

  const invalidRoot = await mkdtemp(join(tmpdir(), "hibro-agent-invalid-yaml-"));
  await writeFile(join(invalidRoot, "agent.yaml"), "metadata: [unterminated\n");
  await assert.rejects(() => readAgentPackage(invalidRoot));
});

test("Agent revisions compile, activate idempotently and roll back", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-agent-revisions-"));
  const agentsRoot = join(root, "agents");
  const registry = new FileAgentRegistry(join(root, "agents.json"));
  await registry.init();
  const manager = new AgentPackageManager(agentsRoot, registry);
  await assert.rejects(
    () => manager.deploy({ agentId: "../escape", origin: "local", bundle: bundle() }),
    /invalid agentId/,
  );
  const first = await manager.deploy({
    agentId: "agt_market",
    definitionId: "adef_market",
    revisionId: "arev_market_1",
    revision: 1,
    expectedHash: agentPackageHash(bundle()),
    origin: "hibro-core",
    bundle: bundle(),
  });
  assert.equal(first.status, "active");
  assert.equal(registry.get("agt_market")?.package?.revisionId, "arev_market_1");

  const workspace = join(root, "workspace-codex");
  await mkdir(workspace);
  await manager.materialize(registry.get("agt_market")!, workspace);
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "You are a careful analyst.\n");
  assert.match(await readFile(join(workspace, ".agents/skills/market-data/SKILL.md"), "utf8"), /Market data/);

  const duplicate = await manager.deploy({
    agentId: "agt_market",
    definitionId: "adef_market",
    revisionId: "arev_market_1",
    revision: 1,
    origin: "hibro-core",
    bundle: bundle(),
  });
  assert.equal(duplicate.contentHash, first.contentHash);
  assert.equal((await manager.list("agt_market")).length, 1);

  await assert.rejects(
    () => manager.deploy({
      agentId: "agt_market",
      revisionId: "arev_broken",
      revision: 2,
      expectedHash: "0".repeat(64),
      origin: "hibro-core",
      bundle: bundle("claude-code", "Second revision\n"),
    }),
    /hash mismatch/,
  );
  assert.equal(registry.get("agt_market")?.package?.revisionId, "arev_market_1");

  const secondBundle = bundle("claude-code", "Second revision\n");
  await manager.deploy({
    agentId: "agt_market",
    definitionId: "adef_market",
    revisionId: "arev_market_2",
    revision: 2,
    expectedHash: agentPackageHash(secondBundle),
    origin: "hibro-core",
    bundle: secondBundle,
  });
  const claudeWorkspace = join(root, "workspace-claude");
  await manager.materialize(registry.get("agt_market")!, claudeWorkspace);
  assert.equal(await readFile(join(claudeWorkspace, "CLAUDE.md"), "utf8"), "Second revision\n");
  assert.match(await readFile(join(claudeWorkspace, ".claude/skills/market-data/SKILL.md"), "utf8"), /Market data/);

  await manager.materialize(registry.get("agt_market")!, workspace);
  await assert.rejects(() => readFile(join(workspace, "AGENTS.md"), "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(join(workspace, ".agents/skills/market-data/SKILL.md"), "utf8"), /ENOENT/);
  assert.equal(await readFile(join(workspace, "CLAUDE.md"), "utf8"), "Second revision\n");

  const openClawBundle = bundle("openclaw", "Third revision\n");
  await manager.deploy({
    agentId: "agt_market",
    definitionId: "adef_market",
    revisionId: "arev_market_3",
    revision: 3,
    expectedHash: agentPackageHash(openClawBundle),
    origin: "hibro-core",
    bundle: openClawBundle,
  });
  const openClawWorkspace = join(root, "workspace-openclaw");
  await manager.materialize(registry.get("agt_market")!, openClawWorkspace);
  assert.equal(await readFile(join(openClawWorkspace, "AGENTS.md"), "utf8"), "Third revision\n");
  assert.match(await readFile(join(openClawWorkspace, ".openclaw/skills/market-data/SKILL.md"), "utf8"), /Market data/);

  await manager.activate("agt_market", "arev_market_1");
  assert.equal(registry.get("agt_market")?.engine, "codex");
  assert.equal(registry.get("agt_market")?.package?.revisionId, "arev_market_1");
  assert.deepEqual((await manager.list("agt_market")).map((item) => [item.revision, item.status]), [
    [3, "inactive"],
    [2, "inactive"],
    [1, "active"],
  ]);
});
