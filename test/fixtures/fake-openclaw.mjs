#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("OpenClaw 2026.7.1-2\n");
  process.exit(0);
}
if (args[0] !== "agent") {
  process.stderr.write(`unsupported command: ${args.join(" ")}\n`);
  process.exit(2);
}
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const config = JSON.parse(
  await readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"),
);
process.stdout.write(
  JSON.stringify({
    payloads: [{ text: `CLAW:${value("--message")}` }],
    sessionKey: value("--session-key"),
    meta: {
      workspace: process.env.OPENCLAW_WORKSPACE_DIR,
      stateDir: process.env.OPENCLAW_STATE_DIR,
      model: config.agents.defaults.model.primary,
      deniedTools: config.tools.deny,
    },
  }),
);
