import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { ClaudeCodeAdapter, ClaudeProcessError } from "../src/claude-code-adapter.ts";

const executable = resolve("test/fixtures/fake-claude.mjs");
await chmod(executable, 0o755);

test("doctor detects installation and login", async () => {
  const result = await new ClaudeCodeAdapter({ executable }).doctor();
  assert.equal(result.installed, true);
  assert.equal(result.loggedIn, true);
  assert.match(result.version ?? "", /Claude Code fake/);
});

test("executes prompt and captures session and result", async () => {
  const events: string[] = [];
  const result = await new ClaudeCodeAdapter({ executable }).execute({
    prompt: "hello",
    workspace: process.cwd(),
    onEvent: (type) => events.push(type),
  });
  assert.equal(result.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.result, "ACK:hello");
  assert.deepEqual(events, ["session.started", "assistant.message", "engine.result"]);
});

test("resumes a supplied Claude session", async () => {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const result = await new ClaudeCodeAdapter({ executable }).execute({
    prompt: "continued",
    workspace: process.cwd(),
    options: { sessionId },
  });
  assert.equal(result.sessionId, sessionId);
});

test("disables tools by default and forwards an explicit allowlist", async () => {
  const adapter = new ClaudeCodeAdapter({ executable });
  const disabled = await adapter.execute({
    prompt: "ARGS",
    workspace: process.cwd(),
  });
  assert.deepEqual(JSON.parse(disabled.result), { tools: "" });

  const allowed = await adapter.execute({
    prompt: "ARGS",
    workspace: process.cwd(),
    options: { allowedTools: ["Read", "Grep"] },
  });
  assert.deepEqual(JSON.parse(allowed.result), { tools: "Read,Grep" });
});

test("maps engine failures to a stable error", async () => {
  await assert.rejects(
    () =>
      new ClaudeCodeAdapter({ executable }).execute({
        prompt: "FAIL",
        workspace: process.cwd(),
      }),
    (error: unknown) =>
      error instanceof ClaudeProcessError && error.code === "engine_failed",
  );
});

test("Claude PreToolUse hook pauses for a Hibro approval decision", async () => {
  const approvals: string[] = [];
  const result = await new ClaudeCodeAdapter({ executable }).execute({
    prompt: "APPROVAL",
    workspace: process.cwd(),
    requestApproval: async (request) => {
      approvals.push(`${request.toolName}:${request.command}`);
      return "allow_once";
    },
  });
  assert.deepEqual(approvals, ["Bash:printf approved"]);
  assert.equal(result.result, "APPROVAL:allow");
});
