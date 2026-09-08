import assert from "node:assert/strict";
import test from "node:test";
import {
  HIBRO_CORE_PROTOCOL,
  createCoreEnvelope,
  parseCoreEnvelope,
} from "../src/core-protocol.ts";

test("Core protocol creates and parses a versioned envelope", () => {
  const message = createCoreEnvelope(
    "run.cancel",
    { commandId: "cmd-1", runId: "run-1", reason: "operator request" },
    { nodeId: "node-1", sequence: 7, requiresAck: true },
  );
  assert.equal(message.protocol, HIBRO_CORE_PROTOCOL);
  assert.equal(parseCoreEnvelope(message).type, "run.cancel");

  const deployment = createCoreEnvelope(
    "agent.revision.deploy",
    {
      deploymentId: "deployment-1",
      definitionId: "definition-1",
      revisionId: "revision-1",
      agentId: "agent-1",
      revision: 1,
      contentHash: "sha256:test",
      bundle: {
        manifest: {
          apiVersion: "hibro.ai/v1alpha1",
          kind: "Agent",
          metadata: { name: "Researcher", slug: "researcher-agent" },
          spec: { engine: "codex", instructions: "instructions.md" },
        },
        files: { "instructions.md": "Research carefully." },
      },
    },
    { nodeId: "node-1", sequence: 8, requiresAck: true },
  );
  assert.equal(parseCoreEnvelope(deployment).type, "agent.revision.deploy");

  const status = createCoreEnvelope(
    "agent.deployment.status",
    {
      deploymentId: "deployment-1",
      definitionId: "definition-1",
      revisionId: "revision-1",
      agentId: "agent-1",
      status: "active",
      observedAt: new Date().toISOString(),
    },
    { nodeId: "node-1", sequence: 9 },
  );
  assert.equal(parseCoreEnvelope(status).type, "agent.deployment.status");
});

test("Core protocol rejects unknown versions, types and invalid sequences", () => {
  assert.throws(
    () =>
      parseCoreEnvelope({
        protocol: "hibro.node.v0",
        messageId: "message-1",
        type: "run.cancel",
        sentAt: new Date().toISOString(),
        payload: {},
      }),
    /unsupported protocol/,
  );
  assert.throws(
    () =>
      parseCoreEnvelope({
        protocol: HIBRO_CORE_PROTOCOL,
        messageId: "message-1",
        type: "unknown",
        sentAt: new Date().toISOString(),
        payload: {},
      }),
    /unsupported message type/,
  );
  assert.throws(
    () =>
      parseCoreEnvelope({
        protocol: HIBRO_CORE_PROTOCOL,
        messageId: "message-1",
        type: "run.cancel",
        sentAt: new Date().toISOString(),
        sequence: 0,
        payload: {},
      }),
    /sequence/,
  );
});
