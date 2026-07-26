import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadClaudeShellEnvironment } from "../src/shell-environment.ts";

const fakeShell = resolve("test/fixtures/fake-shell-env.mjs");
await chmod(fakeShell, 0o755);

test("imports only allowlisted Claude environment variables", async () => {
  const result = await loadClaudeShellEnvironment({
    shellExecutable: fakeShell,
  });
  assert.deepEqual(result.importedKeys, [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
  ]);
  assert.equal(result.environment.ANTHROPIC_API_KEY, "test-secret");
  assert.equal(result.environment.UNRELATED_SECRET, undefined);
});

