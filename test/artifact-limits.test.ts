import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ARTIFACT_MAX_BYTES, nodeArtifactMaxBytes } from "../src/artifact-limits.ts";

test("Artifact limits fall back safely when environment input is malformed", () => {
  assert.equal(nodeArtifactMaxBytes(undefined), DEFAULT_ARTIFACT_MAX_BYTES);
  assert.equal(nodeArtifactMaxBytes("not-a-number"), DEFAULT_ARTIFACT_MAX_BYTES);
  assert.equal(nodeArtifactMaxBytes("-1"), DEFAULT_ARTIFACT_MAX_BYTES);
  assert.equal(nodeArtifactMaxBytes("4096"), 4096);
});
