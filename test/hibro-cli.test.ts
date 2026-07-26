import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url).pathname;
const cliPath = join(repositoryRoot, "scripts", "hibro");

test("hibro CLI reports Node status and forwards update options", () => {
  const root = mkdtempSync(join(tmpdir(), "hibro-node-cli-"));
  const stateDirectory = join(root, "state");
  const sourceRoot = join(root, "source");
  const current = join(sourceRoot, "current");
  const updateLog = join(root, "update.log");
  mkdirSync(stateDirectory, { recursive: true });
  mkdirSync(current, { recursive: true });
  writeFileSync(
    join(stateDirectory, "hibro-node.env"),
    [
      "VERSION=9.8.7",
      "MODE=native",
      "SOURCE=local",
      "INSTALLED_AT=2026-07-26T00:00:00Z",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(current, "install.sh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${updateLog}"\n`,
  );
  const env = {
    ...process.env,
    HIBRO_CLI_NO_SUDO: "true",
    HIBRO_CORE_INSTALL_STATE_FILE: join(root, "missing-core.env"),
    HIBRO_CORE_INSTALL_SOURCE_ROOT: join(root, "missing-core"),
    HIBRO_NODE_INSTALL_STATE_FILE: join(stateDirectory, "hibro-node.env"),
    HIBRO_NODE_INSTALL_SOURCE_ROOT: sourceRoot,
  };

  const status = spawnSync("bash", [cliPath, "node", "status"], {
    encoding: "utf8",
    env,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Hibro Node/);
  assert.match(status.stdout, /版本：9\.8\.7/);
  assert.match(status.stdout, /来源：local/);

  const update = spawnSync(
    "bash",
    [cliPath, "update", "node", "--source", "local"],
    { encoding: "utf8", env },
  );
  assert.equal(update.status, 0, update.stderr);
  assert.equal(readFileSync(updateLog, "utf8"), "--source local\n");
});
