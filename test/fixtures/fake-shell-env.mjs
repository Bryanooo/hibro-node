#!/usr/bin/env node
process.stdout.write(
  [
    "ANTHROPIC_API_KEY=test-secret",
    "ANTHROPIC_BASE_URL=https://example.test",
    "ANTHROPIC_MODEL=test-model",
    "UNRELATED_SECRET=must-not-be-imported",
  ].join("\0") + "\0",
);

