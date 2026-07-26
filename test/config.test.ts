import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { discoverClaudeExecutable } from "../src/config.ts";

test("discovers Claude Code from PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-config-test-"));
  const bin = join(root, "bin");
  const executable = join(bin, "claude");
  await mkdir(bin);
  await writeFile(executable, "#!/bin/sh\n", "utf8");
  await chmod(executable, 0o755);
  assert.equal(discoverClaudeExecutable(root, [bin, "/usr/bin"].join(delimiter)), executable);
});

test("discovers Claude Code from an FNM installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-config-fnm-test-"));
  const bin = join(
    root,
    ".local",
    "share",
    "fnm",
    "node-versions",
    "v24.18.0",
    "installation",
    "bin",
  );
  const executable = join(bin, "claude");
  await mkdir(bin, { recursive: true });
  await writeFile(executable, "#!/bin/sh\n", "utf8");
  await chmod(executable, 0o755);
  assert.equal(discoverClaudeExecutable(root, ""), executable);
});
