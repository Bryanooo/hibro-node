import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { OpenClawAdapter } from "../src/openclaw-adapter.ts";

const executable = resolve("test/fixtures/fake-openclaw.mjs");
await chmod(executable, 0o755);

test("OpenClaw doctor detects installation and shared Anthropic token", async () => {
  const adapter = new OpenClawAdapter({
    executable,
    environment: {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "shared-test-token",
    },
  });
  const doctor = await adapter.doctor();
  assert.equal(doctor.installed, true);
  assert.equal(doctor.ready, true);
  assert.equal(doctor.credentialSource, "ANTHROPIC_AUTH_TOKEN");
  assert.match(doctor.version ?? "", /2026\.7\.1-2/);
});

test("OpenClaw executes with Agent-private state, workspace and session", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-openclaw-"));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state");
  await Promise.all([mkdir(workspace), mkdir(statePath)]);
  const events: string[] = [];
  const adapter = new OpenClawAdapter({
    executable,
    environment: { ANTHROPIC_API_KEY: "test-key" },
  });
  const result = await adapter.execute({
    runId: "run-test",
    agentId: "agent-test",
    prompt: "hello",
    workspace,
    statePath,
    sessionKey: "hibro-review",
    options: {
      sandbox: "read-only",
      model: "anthropic/test-model",
      appendSystemPrompt: "review carefully",
      timeoutMs: 10_000,
    },
    onEvent: (type) => events.push(type),
  });
  assert.equal(
    result.result,
    "CLAW:[Hibro Agent Instructions]\nreview carefully\n\n[Task]\nhello",
  );
  assert.equal(result.sessionId, "hibro-review");
  const meta = result.rawResult?.meta as Record<string, unknown>;
  assert.equal(meta.workspace, workspace);
  assert.equal(meta.stateDir, join(statePath, "openclaw"));
  assert.equal(meta.model, "anthropic/test-model");
  assert.deepEqual(meta.deniedTools, [
    "group:runtime",
    "write",
    "edit",
    "apply_patch",
  ]);
  assert.deepEqual(events, ["session.started", "assistant.message"]);
});
