import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunEvent, RunRecord } from "../src/domain.ts";
import { FileRunStore, SqliteRunStore } from "../src/storage.ts";
import { backupDatabase } from "../scripts/backup-database.ts";
import { restoreDatabase } from "../scripts/restore-database.ts";
import { CoreTransport } from "../src/core-transport.ts";
import { DatabaseSync } from "node:sqlite";

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

test("SQLite moves a poison Core message out of the retry queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-sqlite-deadletter-"));
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  sqlite.enqueueCoreMessage({
    messageId: "poison", type: "run.event", envelopeJson: "{}",
    createdAt: new Date(0).toISOString(), attemptCount: 0,
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    sqlite.markCoreMessageAttempt("poison", new Date(0));
  }
  assert.deepEqual(sqlite.pendingCoreMessages(new Date()), []);
  await sqlite.close();
});

test("SQLite store persists artifact synchronization through Core acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-artifact-sync-"));
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  const runId = randomUUID();
  await sqlite.create(fixtureRun(runId));
  const artifactId = `artifact_${runId}`;
  const completionMessageId = randomUUID();
  sqlite.upsertArtifactSync({
    artifactId,
    runId,
    sha256: "a".repeat(64),
    targetCore: "ws://core.example.test",
    status: "uploading",
    messageId: completionMessageId,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(
    sqlite.findArtifactSyncByMessage(completionMessageId)?.artifactId,
    artifactId,
  );
  sqlite.upsertArtifactSync({
    ...(sqlite.getArtifactSync(artifactId)!),
    status: "synced",
    messageId: undefined,
    updatedAt: "2026-01-01T00:01:00.000Z",
  });
  assert.equal(sqlite.getArtifactSync(artifactId)?.status, "synced");
  await sqlite.pruneTerminalRunsBefore(new Date("2026-02-01T00:00:00.000Z"));
  assert.equal(sqlite.getArtifactSync(artifactId), undefined);
});

test("SQLite persists the artifact catalog without rehashing workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-artifact-catalog-"));
  const runId = randomUUID();
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  await sqlite.create(fixtureRun(runId));
  sqlite.replaceArtifacts(runId, [{
    id: `artifact_${runId}`, runId, engine: "claude-code", title: "report.md",
    localPath: join(root, "report.md"), sizeBytes: 6, sha256: "a".repeat(64), createdAt: new Date().toISOString(),
  }]);
  await sqlite.close();
  const reopened = new SqliteRunStore(root);
  await reopened.init();
  assert.equal(reopened.isArtifactIndexed(runId), true);
  assert.equal(reopened.listArtifacts()[0]?.title, "report.md");
  await reopened.close();
});

test("Node database backup passes integrity checks and remains readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-backup-"));
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  await sqlite.create(fixtureRun(randomUUID()));
  await sqlite.close();
  const destination = await backupDatabase(sqlite.databasePath, join(root, "backups", "snapshot.db"));
  await access(destination);
  const backup = new SqliteRunStore(root, "backups/snapshot.db");
  await backup.init();
  assert.equal((await backup.list()).length, 1);
  assert.equal((await backup.healthCheck()).ok, true);
  await backup.close();
});

test("Node database restore keeps a safety snapshot and restores the selected backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-restore-"));
  const sqlite = new SqliteRunStore(root);
  await sqlite.init();
  const originalId = randomUUID();
  await sqlite.create(fixtureRun(originalId));
  await sqlite.close();
  const backup = await backupDatabase(sqlite.databasePath, join(root, "snapshot.db"));

  const changed = new SqliteRunStore(root);
  await changed.init();
  await changed.create(fixtureRun(randomUUID()));
  await changed.close();
  const result = await restoreDatabase(backup, sqlite.databasePath);
  assert.ok(result.safetyBackup);

  const restored = new SqliteRunStore(root);
  await restored.init();
  assert.deepEqual((await restored.list()).map((run) => run.id), [originalId]);
  assert.equal((await restored.healthCheck()).ok, true);
  await restored.close();
});

test("a restarted Node retries an artifact left in uploading state", () => {
  const enqueued: string[] = [];
  const states: string[] = [];
  const artifact = {
    id: "artifact_retry", runId: randomUUID(), engine: "codex" as const,
    title: "retry.bin", sizeBytes: 1, sha256: "a".repeat(64), createdAt: new Date().toISOString(),
  };
  const manager = {
    getSettings: () => ({ coreEnabled: true, coreUrl: "wss://core.example.test", nodeId: "node_retry-12345678" }),
    getArtifactSyncRecord: () => ({
      artifactId: artifact.id, runId: artifact.runId, sha256: artifact.sha256,
      targetCore: "wss://core.example.test", status: "uploading", updatedAt: new Date(0).toISOString(),
    }),
    setArtifactSync: (_artifact: unknown, status: string) => { states.push(status); },
    store: {
      enqueueCoreMessage: (record: { messageId: string }) => { enqueued.push(record.messageId); },
    },
  };
  const transport = new CoreTransport(manager as never);
  (transport as unknown as { forwardArtifact(value: unknown, retry: boolean): void })
    .forwardArtifact(artifact, true);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(states, ["pending"]);
});

test("Node migrates the previous outbox schema and refuses a future schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "hibro-node-schema-"));
  const legacyPath = join(root, "hibro.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE core_outbox (
      message_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      acknowledged_at TEXT
    );
    PRAGMA user_version = 3;
  `);
  legacy.close();
  const migrated = new SqliteRunStore(root);
  await migrated.init();
  assert.equal((await migrated.healthCheck()).ok, true);
  await migrated.close();

  const futureRoot = await mkdtemp(join(tmpdir(), "hibro-node-future-schema-"));
  const future = new DatabaseSync(join(futureRoot, "hibro.db"));
  future.exec("PRAGMA user_version = 5");
  future.close();
  await assert.rejects(
    () => new SqliteRunStore(futureRoot).init(),
    /newer than supported schema 4/,
  );
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(futureRoot, { recursive: true, force: true }),
  ]);
});
