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
