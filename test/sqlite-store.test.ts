import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunEvent, RunRecord } from "../src/domain.ts";
import { FileRunStore, SqliteRunStore } from "../src/storage.ts";

function fixtureRun(id: string): RunRecord {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    id,
    engine: "claude-code",
    status: "completed",
    request: { prompt: "legacy", workspace: process.cwd() },
    result: "migrated",
    createdAt: timestamp,
    updatedAt: timestamp,
    finishedAt: timestamp,
  };
}

function fixtureEvent(runId: string): RunEvent {
  return {
    runId,
    sequence: 1,
    type: "run.completed",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { migrated: true },
  };
}

test("SQLite store imports legacy JSON runs and events once", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-sqlite-migration-"));
  const runId = randomUUID();
  const legacy = new FileRunStore(root);
  await legacy.init();
  await legacy.create(fixtureRun(runId));
  await legacy.appendEvent(fixtureEvent(runId));

  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  assert.equal((await sqlite.get(runId))?.result, "migrated");
  assert.deepEqual(await sqlite.getEvents(runId), [fixtureEvent(runId)]);
  await access(sqlite.databasePath);

  const reopened = new SqliteRunStore(root);
  await reopened.init();
  assert.equal((await reopened.list()).length, 1);
  assert.equal((await reopened.getEvents(runId)).length, 1);
});

test("SQLite store persists updates and cascades event cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-sqlite-store-"));
  const runId = randomUUID();
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  const run = fixtureRun(runId);
  await sqlite.create(run);
  await sqlite.appendEvent(fixtureEvent(runId));
  run.result = "updated";
  run.updatedAt = "2026-01-02T00:00:00.000Z";
  await sqlite.update(run);
  assert.equal((await sqlite.get(runId))?.result, "updated");
  assert.deepEqual(
    await sqlite.pruneTerminalRunsBefore(new Date("2026-02-01T00:00:00.000Z")),
    [runId],
  );
  assert.equal(await sqlite.get(runId), undefined);
  assert.deepEqual(await sqlite.getEvents(runId), []);
});

test("SQLite store persists Core outbox messages until acknowledged", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-sqlite-outbox-"));
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  const messageId = randomUUID();
  sqlite.enqueueCoreMessage({
    messageId,
    type: "run.event",
    envelopeJson: JSON.stringify({ messageId, type: "run.event" }),
    createdAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 0,
  });

  assert.equal(sqlite.pendingCoreMessages(new Date("2026-01-01T00:00:01.000Z")).length, 1);
  sqlite.markCoreMessageAttempt(messageId, new Date("2026-01-01T00:01:00.000Z"));
  assert.equal(sqlite.pendingCoreMessages(new Date("2026-01-01T00:00:30.000Z")).length, 0);
  assert.equal(sqlite.pendingCoreMessages(new Date("2026-01-01T00:01:01.000Z"))[0]?.attemptCount, 1);
  sqlite.acknowledgeCoreMessage(messageId, new Date("2026-01-01T00:01:02.000Z"));
  assert.deepEqual(sqlite.pendingCoreMessages(new Date("2026-01-01T00:02:00.000Z")), []);
});
