#!/usr/bin/env node
import { chmod, mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "hibro-node-e2e-"));
const dataDir = join(sandbox, ".hibro");
const port = process.env.HIBRO_E2E_PORT ?? "17335";
const fixtures = {
  claude: resolve("test/fixtures/fake-claude.mjs"),
  codex: resolve("test/fixtures/fake-codex.mjs"),
  openclaw: resolve("test/fixtures/fake-openclaw.mjs"),
};

await Promise.all(Object.values(fixtures).map((path) => chmod(path, 0o755)));

process.on("exit", () => {
  rmSync(sandbox, { recursive: true, force: true });
});

process.argv = [
  process.execPath,
  resolve("src/cli.ts"),
  "serve",
  "--host",
  "127.0.0.1",
  "--port",
  port,
  "--data-dir",
  dataDir,
  "--claude-bin",
  fixtures.claude,
  "--codex-bin",
  fixtures.codex,
  "--openclaw-bin",
  fixtures.openclaw,
  "--no-shell-env",
];

await import("../src/cli.ts");
