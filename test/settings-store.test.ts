import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileSettingsStore } from "../src/settings-store.ts";

test("system settings persist validated runtime controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-settings-"));
  const path = join(root, "settings.json");
  const store = new FileSettingsStore(path);
  await store.init();
  const updated = await store.update({
    nodeName: "Kitchen Mac",
    maxConcurrentRuns: 6,
    defaultTimeoutMs: 90_000,
    autoResumeSessions: false,
  });
  assert.equal(updated.nodeName, "Kitchen Mac");
  assert.equal(updated.maxConcurrentRuns, 6);
  assert.equal(updated.autoResumeSessions, false);

  const reloaded = new FileSettingsStore(path);
  await reloaded.init();
  assert.equal(reloaded.get().defaultTimeoutMs, 90_000);
  assert.equal(reloaded.get().maxConcurrentRuns, 6);
});

test("system settings reject unsafe or incomplete values", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-settings-invalid-"));
  const store = new FileSettingsStore(join(root, "settings.json"));
  await store.init();
  await assert.rejects(() => store.update({ maxConcurrentRuns: 0 }), /positive integer/);
  await assert.rejects(
    () => store.update({ coreEnabled: true, coreUrl: undefined }),
    /coreUrl is required/,
  );
  await assert.rejects(
    () =>
      store.update({
        coreEnabled: true,
        coreUrl: "ws://hibro-core.test",
        coreToken: undefined,
      }),
    /coreToken is required/,
  );
});
