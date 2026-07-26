import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RunEvent, RunRecord } from "./domain.ts";

function assertSafeRunId(runId: string): void {
  if (
    !/^(?:run_)?[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      runId,
    )
  ) {
    throw new Error("Invalid run ID");
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export interface CoreOutboxRecord {
  messageId: string;
  type: string;
  envelopeJson: string;
  createdAt: string;
  attemptCount: number;
  nextAttemptAt?: string | undefined;
}

export interface ArtifactSyncRecord {
  artifactId: string;
  runId: string;
  sha256?: string | undefined;
  targetCore?: string | undefined;
  status: "local_only" | "pending" | "uploading" | "synced" | "failed";
  messageId?: string | undefined;
  error?: string | undefined;
  updatedAt: string;
}

export interface RunStore {
  readonly rootDir: string;
  readonly databasePath?: string | undefined;
  init(): Promise<void>;
  create(run: RunRecord): Promise<void>;
  update(run: RunRecord): Promise<void>;
  get(runId: string): Promise<RunRecord | undefined>;
  list(): Promise<RunRecord[]>;
  appendEvent(event: RunEvent): Promise<void>;
  getEvents(runId: string, afterSequence?: number): Promise<RunEvent[]>;
  pruneTerminalRunsBefore(cutoff: Date): Promise<string[]>;
  enqueueCoreMessage(record: CoreOutboxRecord): void;
  pendingCoreMessages(now?: Date, limit?: number): CoreOutboxRecord[];
  markCoreMessageAttempt(messageId: string, nextAttemptAt: Date): void;
  acknowledgeCoreMessage(messageId: string, acknowledgedAt?: Date): void;
  getArtifactSync(artifactId: string): ArtifactSyncRecord | undefined;
  findArtifactSyncByMessage(messageId: string): ArtifactSyncRecord | undefined;
  upsertArtifactSync(record: ArtifactSyncRecord): void;
  hasProcessedCoreCommand(messageId: string): boolean;
  rememberProcessedCoreCommand(messageId: string, processedAt?: Date): void;
  pruneProtocolHistory(cutoff: Date): void;
}

export class FileRunStore implements RunStore {
  readonly rootDir: string;
  private readonly coreOutbox = new Map<string, CoreOutboxRecord>();
  private readonly processedCoreCommands = new Map<string, string>();
  private readonly artifactSync = new Map<string, ArtifactSyncRecord>();

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  async init(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await mkdir(this.runsDir(), { recursive: true, mode: 0o700 });
  }

  async create(run: RunRecord): Promise<void> {
    assertSafeRunId(run.id);
    await mkdir(this.runDir(run.id), { recursive: false });
    await writeJsonAtomically(this.statePath(run.id), run);
  }

  async update(run: RunRecord): Promise<void> {
    assertSafeRunId(run.id);
    await writeJsonAtomically(this.statePath(run.id), run);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    assertSafeRunId(runId);
    try {
      return await readJson<RunRecord>(this.statePath(runId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.runsDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const runs = await Promise.all(entries.map((entry) => this.get(entry)));
    return runs
      .filter((run): run is RunRecord => run !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendEvent(event: RunEvent): Promise<void> {
    assertSafeRunId(event.runId);
    await appendFile(this.eventsPath(event.runId), `${JSON.stringify(event)}\n`, "utf8");
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    assertSafeRunId(runId);
    try {
      const content = await readFile(this.eventsPath(runId), "utf8");
      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent)
        .filter((event) => event.sequence > afterSequence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async pruneTerminalRunsBefore(cutoff: Date): Promise<string[]> {
    const removed: string[] = [];
    for (const run of await this.list()) {
      if (
        !["completed", "failed", "cancelled", "timed_out"].includes(run.status) ||
        new Date(run.finishedAt ?? run.updatedAt).getTime() >= cutoff.getTime()
      ) {
        continue;
      }
      assertSafeRunId(run.id);
      await rm(this.runDir(run.id), { recursive: true, force: true });
      for (const [artifactId, sync] of this.artifactSync) {
        if (sync.runId === run.id) this.artifactSync.delete(artifactId);
      }
      removed.push(run.id);
    }
    return removed;
  }

  enqueueCoreMessage(record: CoreOutboxRecord): void {
    if (!this.coreOutbox.has(record.messageId)) {
      this.coreOutbox.set(record.messageId, { ...record });
    }
  }

  pendingCoreMessages(now = new Date(), limit = 100): CoreOutboxRecord[] {
    return [...this.coreOutbox.values()]
      .filter(
        (record) =>
          !record.nextAttemptAt ||
          new Date(record.nextAttemptAt).getTime() <= now.getTime(),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map((record) => ({ ...record }));
  }

  markCoreMessageAttempt(messageId: string, nextAttemptAt: Date): void {
    const record = this.coreOutbox.get(messageId);
    if (!record) return;
    record.attemptCount += 1;
    record.nextAttemptAt = nextAttemptAt.toISOString();
  }

  acknowledgeCoreMessage(messageId: string): void {
    this.coreOutbox.delete(messageId);
  }

  getArtifactSync(artifactId: string): ArtifactSyncRecord | undefined {
    const record = this.artifactSync.get(artifactId);
    return record ? { ...record } : undefined;
  }

  findArtifactSyncByMessage(messageId: string): ArtifactSyncRecord | undefined {
    const record = [...this.artifactSync.values()].find(
      (candidate) => candidate.messageId === messageId,
    );
    return record ? { ...record } : undefined;
  }

  upsertArtifactSync(record: ArtifactSyncRecord): void {
    this.artifactSync.set(record.artifactId, { ...record });
  }

  hasProcessedCoreCommand(messageId: string): boolean {
    return this.processedCoreCommands.has(messageId);
  }

  rememberProcessedCoreCommand(messageId: string, processedAt = new Date()): void {
    this.processedCoreCommands.set(messageId, processedAt.toISOString());
  }

  pruneProtocolHistory(cutoff: Date): void {
    for (const [messageId, processedAt] of this.processedCoreCommands) {
      if (processedAt < cutoff.toISOString()) {
        this.processedCoreCommands.delete(messageId);
      }
    }
  }

  private runsDir(): string {
    return join(this.rootDir, "runs");
  }

  private runDir(runId: string): string {
    return join(this.runsDir(), runId);
  }

  private statePath(runId: string): string {
    return join(this.runDir(runId), "state.json");
  }

  private eventsPath(runId: string): string {
    return join(this.runDir(runId), "events.jsonl");
  }
}

interface PayloadRow {
  payload_json: string;
}

interface MetaRow {
  value: string;
}

interface OutboxRow {
  message_id: string;
  created_at: string;
  type: string;
  payload_json: string;
  attempt_count: number;
  next_attempt_at: string | null;
}

interface ArtifactSyncRow {
  artifact_id: string;
  run_id: string;
  sha256: string | null;
  target_core: string | null;
  status: ArtifactSyncRecord["status"];
  message_id: string | null;
  error: string | null;
  updated_at: string;
}

function artifactSyncFromRow(row: ArtifactSyncRow): ArtifactSyncRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    sha256: row.sha256 ?? undefined,
    targetCore: row.target_core ?? undefined,
    status: row.status,
    messageId: row.message_id ?? undefined,
    error: row.error ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class SqliteRunStore implements RunStore {
  readonly rootDir: string;
  readonly databasePath: string;
  private database: DatabaseSync | undefined;

  constructor(rootDir: string, filename = "hibro.db") {
    this.rootDir = rootDir;
    this.databasePath = join(rootDir, filename);
  }

  async init(): Promise<void> {
    if (this.database) return;
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await chmod(this.rootDir, 0o700);
    const database = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS hibro_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        engine TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS runs_agent_status_idx ON runs(agent_id, status);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS run_events_timestamp_idx ON run_events(timestamp);
      CREATE TABLE IF NOT EXISTS core_outbox (
        message_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS core_outbox_pending_idx
        ON core_outbox(acknowledged_at, next_attempt_at, created_at);
      CREATE TABLE IF NOT EXISTS core_command_inbox (
        message_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_command_inbox_processed_idx
        ON core_command_inbox(processed_at);
      CREATE TABLE IF NOT EXISTS artifact_sync (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        sha256 TEXT,
        target_core TEXT,
        status TEXT NOT NULL,
        message_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS artifact_sync_message_idx
        ON artifact_sync(message_id);
      CREATE INDEX IF NOT EXISTS artifact_sync_status_idx
        ON artifact_sync(status, updated_at);
      PRAGMA user_version = 3;
    `);
    this.database = database;
    await chmod(this.databasePath, 0o600);
    await this.importLegacyRuns();
  }

  async create(run: RunRecord): Promise<void> {
    assertSafeRunId(run.id);
    this.connection()
      .prepare(`
        INSERT INTO runs (
          id, agent_id, engine, status, created_at, updated_at, finished_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.agentId ?? null,
        run.engine,
        run.status,
        run.createdAt,
        run.updatedAt,
        run.finishedAt ?? null,
        JSON.stringify(run),
      );
  }

  async update(run: RunRecord): Promise<void> {
    assertSafeRunId(run.id);
    this.upsertRun(run);
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    assertSafeRunId(runId);
    const row = this.connection()
      .prepare("SELECT payload_json FROM runs WHERE id = ?")
      .get(runId) as PayloadRow | undefined;
    return row ? (JSON.parse(row.payload_json) as RunRecord) : undefined;
  }

  async list(): Promise<RunRecord[]> {
    const rows = this.connection()
      .prepare("SELECT payload_json FROM runs ORDER BY created_at DESC")
      .all() as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as RunRecord);
  }

  async appendEvent(event: RunEvent): Promise<void> {
    assertSafeRunId(event.runId);
    this.connection()
      .prepare(`
        INSERT INTO run_events (run_id, sequence, type, timestamp, payload_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, sequence) DO UPDATE SET
          type = excluded.type,
          timestamp = excluded.timestamp,
          payload_json = excluded.payload_json
      `)
      .run(
        event.runId,
        event.sequence,
        event.type,
        event.timestamp,
        JSON.stringify(event),
      );
  }

  async getEvents(runId: string, afterSequence = 0): Promise<RunEvent[]> {
    assertSafeRunId(runId);
    const rows = this.connection()
      .prepare(`
        SELECT payload_json
        FROM run_events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `)
      .all(runId, afterSequence) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as RunEvent);
  }

  async pruneTerminalRunsBefore(cutoff: Date): Promise<string[]> {
    const removed = (await this.list())
      .filter(
        (run) =>
          ["completed", "failed", "cancelled", "timed_out"].includes(run.status) &&
          new Date(run.finishedAt ?? run.updatedAt).getTime() < cutoff.getTime(),
      )
      .map((run) => run.id);
    const statement = this.connection().prepare("DELETE FROM runs WHERE id = ?");
    for (const runId of removed) statement.run(runId);
    return removed;
  }

  enqueueCoreMessage(record: CoreOutboxRecord): void {
    this.connection()
      .prepare(`
        INSERT OR IGNORE INTO core_outbox (
          message_id, created_at, type, payload_json, attempt_count, next_attempt_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.messageId,
        record.createdAt,
        record.type,
        record.envelopeJson,
        record.attemptCount,
        record.nextAttemptAt ?? null,
      );
  }

  pendingCoreMessages(now = new Date(), limit = 100): CoreOutboxRecord[] {
    const rows = this.connection()
      .prepare(`
        SELECT message_id, created_at, type, payload_json, attempt_count, next_attempt_at
        FROM core_outbox
        WHERE acknowledged_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY created_at ASC, rowid ASC
        LIMIT ?
      `)
      .all(now.toISOString(), limit) as unknown as OutboxRow[];
    return rows.map((row) => ({
      messageId: row.message_id,
      type: row.type,
      envelopeJson: row.payload_json,
      createdAt: row.created_at,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at ?? undefined,
    }));
  }

  markCoreMessageAttempt(messageId: string, nextAttemptAt: Date): void {
    this.connection()
      .prepare(`
        UPDATE core_outbox
        SET attempt_count = attempt_count + 1, next_attempt_at = ?
        WHERE message_id = ? AND acknowledged_at IS NULL
      `)
      .run(nextAttemptAt.toISOString(), messageId);
  }

  acknowledgeCoreMessage(messageId: string, acknowledgedAt = new Date()): void {
    this.connection()
      .prepare(`
        UPDATE core_outbox
        SET acknowledged_at = ?, next_attempt_at = NULL
        WHERE message_id = ?
      `)
      .run(acknowledgedAt.toISOString(), messageId);
  }

  getArtifactSync(artifactId: string): ArtifactSyncRecord | undefined {
    const row = this.connection()
      .prepare("SELECT * FROM artifact_sync WHERE artifact_id = ?")
      .get(artifactId) as ArtifactSyncRow | undefined;
    return row ? artifactSyncFromRow(row) : undefined;
  }

  findArtifactSyncByMessage(messageId: string): ArtifactSyncRecord | undefined {
    const row = this.connection()
      .prepare("SELECT * FROM artifact_sync WHERE message_id = ?")
      .get(messageId) as ArtifactSyncRow | undefined;
    return row ? artifactSyncFromRow(row) : undefined;
  }

  upsertArtifactSync(record: ArtifactSyncRecord): void {
    this.connection()
      .prepare(`
        INSERT INTO artifact_sync(
          artifact_id, run_id, sha256, target_core, status,
          message_id, error, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          run_id = excluded.run_id,
          sha256 = excluded.sha256,
          target_core = excluded.target_core,
          status = excluded.status,
          message_id = excluded.message_id,
          error = excluded.error,
          updated_at = excluded.updated_at
      `)
      .run(
        record.artifactId,
        record.runId,
        record.sha256 ?? null,
        record.targetCore ?? null,
        record.status,
        record.messageId ?? null,
        record.error ?? null,
        record.updatedAt,
      );
  }

  hasProcessedCoreCommand(messageId: string): boolean {
    return Boolean(
      this.connection()
        .prepare("SELECT message_id FROM core_command_inbox WHERE message_id = ?")
        .get(messageId),
    );
  }

  rememberProcessedCoreCommand(
    messageId: string,
    processedAt = new Date(),
  ): void {
    this.connection()
      .prepare(`
        INSERT INTO core_command_inbox(message_id, processed_at)
        VALUES (?, ?)
        ON CONFLICT(message_id) DO NOTHING
      `)
      .run(messageId, processedAt.toISOString());
  }

  pruneProtocolHistory(cutoff: Date): void {
    const timestamp = cutoff.toISOString();
    const database = this.connection();
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare("DELETE FROM core_outbox WHERE acknowledged_at < ?")
        .run(timestamp);
      database
        .prepare("DELETE FROM core_command_inbox WHERE processed_at < ?")
        .run(timestamp);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private connection(): DatabaseSync {
    if (!this.database) throw new Error("SQLite run store is not initialized");
    return this.database;
  }

  private upsertRun(run: RunRecord): void {
    this.connection()
      .prepare(`
        INSERT INTO runs (
          id, agent_id, engine, status, created_at, updated_at, finished_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          agent_id = excluded.agent_id,
          engine = excluded.engine,
          status = excluded.status,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          finished_at = excluded.finished_at,
          payload_json = excluded.payload_json
      `)
      .run(
        run.id,
        run.agentId ?? null,
        run.engine,
        run.status,
        run.createdAt,
        run.updatedAt,
        run.finishedAt ?? null,
        JSON.stringify(run),
      );
  }

  private async importLegacyRuns(): Promise<void> {
    const connection = this.connection();
    const marker = connection
      .prepare("SELECT value FROM hibro_meta WHERE key = ?")
      .get("legacy_runs_imported") as MetaRow | undefined;
    if (marker?.value === "1") return;

    let entries: string[] = [];
    try {
      entries = await readdir(join(this.rootDir, "runs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9-]{36}$/i.test(entry)) continue;
      try {
        const run = await readJson<RunRecord>(
          join(this.rootDir, "runs", entry, "state.json"),
        );
        this.upsertRun(run);
        const eventsPath = join(this.rootDir, "runs", entry, "events.jsonl");
        let content = "";
        try {
          content = await readFile(eventsPath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        for (const line of content.split("\n").filter(Boolean)) {
          const event = JSON.parse(line) as RunEvent;
          await this.appendEvent(event);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    connection
      .prepare(`
        INSERT INTO hibro_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run("legacy_runs_imported", "1");
  }
}
