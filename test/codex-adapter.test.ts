import assert from "node:assert/strict";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexAdapter } from "../src/codex-adapter.ts";

const executable = resolve("test/fixtures/fake-codex.mjs");
await chmod(executable, 0o755);

test("Codex adapter checks login and parses JSONL output", async () => {
  const adapter = new CodexAdapter({ executable });
  const doctor = await adapter.doctor();
  assert.equal(doctor.ready, true);
  assert.match(doctor.version ?? "", /0\.145\.0/);

  const events: string[] = [];
  const result = await adapter.execute({
    prompt: "hello",
    workspace: process.cwd(),
    onEvent: (type) => events.push(type),
  });
  assert.equal(result.sessionId, "44444444-4444-4444-8444-444444444444");
  assert.equal(result.result, "CODEX:hello");
  assert.ok(events.includes("session.started"));
  assert.ok(events.includes("assistant.message"));
});

test("Codex adapter resumes a supplied session", async () => {
  const adapter = new CodexAdapter({ executable });
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const result = await adapter.execute({
    prompt: "continue",
    workspace: process.cwd(),
    options: { sessionId },
  });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.result, "CODEX:continue");
});

test("Codex adapter keeps session state in the Agent-private state directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-codex-state-"));
  const statePath = join(root, "state");
  const adapter = new CodexAdapter({ executable });
  await adapter.execute({
    prompt: "state",
    workspace: process.cwd(),
    statePath,
  });
  assert.equal((await stat(join(statePath, "codex"))).isDirectory(), true);
});

test("Codex app-server approval request is resolved through Hibro", async () => {
  const approvals: string[] = [];
  const result = await new CodexAdapter({ executable }).execute({
    prompt: "APPROVAL",
    workspace: process.cwd(),
    requestApproval: async (request) => {
      approvals.push(`${request.kind}:${request.command}`);
      return "allow_always";
    },
  });
  assert.deepEqual(approvals, ["command:printf approved"]);
  assert.equal(result.result, "CODEX:APPROVAL:acceptForSession");
});

test("approval waiting time does not consume the Codex execution timeout", async () => {
  const result = await new CodexAdapter({ executable }).execute({
    prompt: "APPROVAL",
    workspace: process.cwd(),
    options: { timeoutMs: 40 },
    requestApproval: async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      return "allow_once";
    },
  });
  assert.equal(result.result, "CODEX:APPROVAL:accept");
});

test("Codex timeout is reported as timeout instead of an exit error", async () => {
  await assert.rejects(
    new CodexAdapter({ executable }).execute({
      prompt: "HANG",
      workspace: process.cwd(),
      options: { timeoutMs: 200 },
    }),
    (error: Error & { code?: string }) => error.code === "timeout",
  );
});
