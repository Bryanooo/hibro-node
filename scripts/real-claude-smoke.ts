import assert from "node:assert/strict";
import { resolve } from "node:path";
import { ClaudeCodeAdapter } from "../src/claude-code-adapter.ts";
import { loadConfig } from "../src/config.ts";
import { loadClaudeShellEnvironment } from "../src/shell-environment.ts";

const config = loadConfig();
const shellEnvironment = config.importShellEnvironment
  ? await loadClaudeShellEnvironment({
      shellExecutable: config.shellExecutable,
    })
  : { environment: {}, importedKeys: [] };
const adapter = new ClaudeCodeAdapter({
  executable: config.claudeExecutable,
  environment: shellEnvironment.environment,
});

const doctor = await adapter.doctor();
assert.equal(doctor.installed, true, doctor.error ?? "Claude Code is not installed");
assert.equal(doctor.loggedIn, true, doctor.error ?? "Claude Code is not authenticated");

const eventTypes: string[] = [];
let textDeltaCount = 0;
const first = await adapter.execute({
  prompt: "Reply with exactly HIBRO_FIRST_OK and nothing else.",
  workspace: resolve("."),
  options: {
    permissionMode: "dontAsk",
    allowedTools: [],
    timeoutMs: 60_000,
  },
  onEvent: (type, payload) => {
    eventTypes.push(type);
    if (
      type === "engine.delta" &&
      JSON.stringify(payload).includes('"text_delta"')
    ) {
      textDeltaCount += 1;
    }
  },
});
assert.match(first.result, /HIBRO_FIRST_OK/);
assert.ok(first.sessionId, "Claude did not return a session ID");
assert.ok(eventTypes.includes("session.started"));
assert.ok(eventTypes.includes("engine.result"));
assert.ok(textDeltaCount > 0, "Claude did not emit streamed text deltas");

const resumed = await adapter.execute({
  prompt: "Reply with exactly HIBRO_RESUME_OK and nothing else.",
  workspace: resolve("."),
  options: {
    sessionId: first.sessionId,
    permissionMode: "dontAsk",
    allowedTools: [],
    timeoutMs: 60_000,
  },
});
assert.match(resumed.result, /HIBRO_RESUME_OK/);
assert.equal(resumed.sessionId, first.sessionId);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      executable: config.claudeExecutable,
      importedShellKeys: shellEnvironment.importedKeys,
      credentialSource: doctor.credentialSource,
      modelProvider: doctor.apiProvider,
      sessionId: first.sessionId,
      firstResult: first.result,
      resumedResult: resumed.result,
      eventTypes: [...new Set(eventTypes)],
      textDeltaCount,
    },
    null,
    2,
  )}\n`,
);
