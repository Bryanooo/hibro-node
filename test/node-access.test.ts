import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isNodeControlRequestAuthorized,
  loadNodeControlCredential,
} from "../src/node-access.ts";

test("Node control credential is generated once with owner-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-access-"));
  const generated = await loadNodeControlCredential(root, "");
  assert.equal(generated.generated, true);
  assert.ok(generated.token.length >= 32);
  assert.equal((await stat(join(root, "control-token"))).mode & 0o777, 0o600);
  const reopened = await loadNodeControlCredential(root, "");
  assert.equal(reopened.generated, false);
  assert.equal(reopened.token, generated.token);

  const request = {
    headers: {
      authorization: `Basic ${Buffer.from(`hibro:${generated.token}`).toString("base64")}`,
    },
  } as IncomingMessage;
  assert.equal(
    isNodeControlRequestAuthorized(request, generated.token),
    true,
  );
});

