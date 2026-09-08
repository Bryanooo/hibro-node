import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EngineManager,
  type EnginePackageInstaller,
} from "../src/engine-manager.ts";

class FakeInstaller implements EnginePackageInstaller {
  readonly calls: Array<{ packageSpec: string; prefix: string }> = [];
  fail = false;

  async install(
    packageSpec: string,
    prefix: string,
    _signal?: AbortSignal,
    onOutput?: (text: string) => void,
  ): Promise<void> {
    this.calls.push({ packageSpec, prefix });
    if (this.fail) throw new Error("registry unavailable");
    onOutput?.("token=must-not-persist\npackage installed\n");
    const executable = packageSpec.startsWith("@openai/codex@")
      ? "codex"
      : packageSpec.startsWith("@anthropic-ai/claude-code@")
        ? "claude"
        : "openclaw";
    const bin = join(prefix, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, executable), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, executable), 0o755);
  }
}

test("Engine Manager installs exact official packages and persists lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-engines-"));
  const installer = new FakeInstaller();
  const manager = new EngineManager(root, { installer });
  await manager.init();

  assert.equal(manager.catalog().length, 3);
  assert.equal(manager.get("codex").status, "absent");
  await assert.rejects(
    manager.install("codex", "latest"),
    /exact version/,
  );

  const installed = await manager.install("codex", "0.145.0");
  assert.equal(installed.status, "installed");
  assert.equal(installed.installedVersion, "0.145.0");
  assert.match(manager.resolveExecutable("codex", "codex"), /\.hibro|hibro-engines-/);
  assert.equal(installer.calls[0]?.packageSpec, "@openai/codex@0.145.0");

  await manager.install("codex", "0.145.0");
  assert.equal(installer.calls.length, 1, "an intact current version must not be reinstalled");
  await manager.install("codex", "0.146.0");
  assert.deepEqual(manager.get("codex").installedVersions, ["0.145.0", "0.146.0"]);
  assert.equal(manager.get("codex").lastOperation?.log.some((line) => line.includes("must-not-persist")), false);
  await manager.activate("codex", "0.145.0");
  assert.equal(manager.get("codex").installedVersion, "0.145.0");

  const reloaded = new EngineManager(root, { installer });
  await reloaded.init();
  assert.equal(reloaded.get("codex").installedVersion, "0.145.0");
  assert.equal(JSON.parse(await readFile(join(root, "state.json"), "utf8")).schemaVersion, 1);
});

test("Engine Manager can disable and uninstall only its managed copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-engines-policy-"));
  const installer = new FakeInstaller();
  const manager = new EngineManager(root, { installer });
  await manager.init();
  await manager.install("openclaw");

  const disabled = await manager.setEnabled("openclaw", false);
  assert.equal(disabled.status, "disabled");
  assert.equal(manager.isEnabled("openclaw"), false);
  assert.equal(manager.resolveExecutable("openclaw", "/usr/bin/openclaw"), "/usr/bin/openclaw");

  await manager.setEnabled("openclaw", true);
  const removed = await manager.uninstall("openclaw");
  assert.equal(removed.status, "absent");
  assert.equal(removed.installedVersion, undefined);
  assert.equal(manager.resolveExecutable("openclaw", "/usr/bin/openclaw"), "/usr/bin/openclaw");
});

test("a failed update retains the last usable managed version", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-engines-rollback-"));
  const installer = new FakeInstaller();
  const manager = new EngineManager(root, { installer });
  await manager.init();
  await manager.install("claude-code", "2.1.218");
  const executable = manager.resolveExecutable("claude-code", "claude");

  installer.fail = true;
  await assert.rejects(manager.install("claude-code", "2.1.219"), /registry unavailable/);
  assert.equal(manager.get("claude-code").installedVersion, "2.1.218");
  assert.equal(manager.resolveExecutable("claude-code", "claude"), executable);
  assert.equal(manager.get("claude-code").status, "failed");
});
