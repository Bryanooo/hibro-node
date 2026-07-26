import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Conversation,
  ConversationActivity,
  ConversationDetail,
  ConversationEvent,
  ConversationMessage,
} from "./conversation-domain.ts";

interface PayloadRow {
  payload_json: string;
}

interface SequenceRow {
  sequence: number;
}

export class ConversationStore {
  private database: DatabaseSync | undefined;
  readonly databasePath: string;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
  }

  async init(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.databasePath), { recursive: true });
    const database = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_updated_idx
        ON conversations(updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_order_idx
        ON conversation_messages(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_activities (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        run_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS conversation_activities_order_idx
        ON conversation_activities(conversation_id, created_at);

      CREATE TABLE IF NOT EXISTS conversation_events (
        conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source_key TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(conversation_id, sequence),
        UNIQUE(source_key),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS processed_conversation_run_events (
        source_key TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );
    `);
    this.database = database;
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  list(): Conversation[] {
    return this.many<Conversation>(
      "SELECT payload_json FROM conversations ORDER BY updated_at DESC",
    );
  }

  get(id: string): Conversation | undefined {
    return this.one<Conversation>(
      "SELECT payload_json FROM conversations WHERE id = ?",
      id,
    );
  }

  create(conversation: Conversation): void {
    this.db()
      .prepare(`
        INSERT INTO conversations(
          id, agent_id, status, source, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        conversation.id,
        conversation.agentId,
        conversation.status,
        conversation.source,
        conversation.updatedAt,
        JSON.stringify(conversation),
      );
  }

  save(conversation: Conversation): void {
    this.db()
      .prepare(`
        UPDATE conversations
        SET agent_id = ?, status = ?, source = ?, updated_at = ?, payload_json = ?
        WHERE id = ?
      `)
      .run(
        conversation.agentId,
        conversation.status,
        conversation.source,
        conversation.updatedAt,
        JSON.stringify(conversation),
        conversation.id,
      );
  }

  getMessage(id: string): ConversationMessage | undefined {
    return this.one<ConversationMessage>(
      "SELECT payload_json FROM conversation_messages WHERE id = ?",
      id,
    );
  }

  listMessages(conversationId: string): ConversationMessage[] {
    return this.many<ConversationMessage>(
      `
        SELECT payload_json FROM conversation_messages
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
      `,
      conversationId,
    );
  }

  createMessage(message: ConversationMessage): void {
    this.db()
      .prepare(`
        INSERT INTO conversation_messages(
          id, conversation_id, role, status, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.conversationId,
        message.role,
        message.status,
        message.createdAt,
        JSON.stringify(message),
      );
  }

  saveMessage(message: ConversationMessage): void {
    this.db()
      .prepare(`
        UPDATE conversation_messages
        SET role = ?, status = ?, payload_json = ?
        WHERE id = ?
      `)
      .run(message.role, message.status, JSON.stringify(message), message.id);
  }

  getActivity(id: string): ConversationActivity | undefined {
    return this.one<ConversationActivity>(
      "SELECT payload_json FROM conversation_activities WHERE id = ?",
      id,
    );
  }

  listActivities(conversationId: string): ConversationActivity[] {
    return this.many<ConversationActivity>(
      `
        SELECT payload_json FROM conversation_activities
        WHERE conversation_id = ?
        ORDER BY created_at ASC, rowid ASC
      `,
      conversationId,
    );
  }

  upsertActivity(activity: ConversationActivity): void {
    this.db()
      .prepare(`
        INSERT INTO conversation_activities(
          id, conversation_id, run_id, type, status, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          run_id = excluded.run_id,
          type = excluded.type,
          status = excluded.status,
          payload_json = excluded.payload_json
      `)
      .run(
        activity.id,
        activity.conversationId,
        activity.runId ?? null,
        activity.type,
        activity.status,
        activity.createdAt,
        JSON.stringify(activity),
      );
  }

  appendEvent(
    event: Omit<ConversationEvent, "sequence">,
    sourceKey?: string,
  ): ConversationEvent | undefined {
    const previous = this.db()
      .prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM conversation_events WHERE conversation_id = ?
      `)
      .get(event.conversationId) as unknown as SequenceRow;
    const complete: ConversationEvent = {
      ...event,
      sequence: Number(previous.sequence) + 1,
    };
    const result = this.db()
      .prepare(`
        INSERT OR IGNORE INTO conversation_events(
          conversation_id, sequence, type, created_at, source_key, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        complete.conversationId,
        complete.sequence,
        complete.type,
        complete.createdAt,
        sourceKey ?? null,
        JSON.stringify(complete),
      );
    return Number(result.changes) === 1 ? complete : undefined;
  }

  claimRunEvent(sourceKey: string): boolean {
    const result = this.db()
      .prepare(`
        INSERT OR IGNORE INTO processed_conversation_run_events(source_key, processed_at)
        VALUES (?, ?)
      `)
      .run(sourceKey, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  pruneProcessedRunEvents(cutoff: Date): void {
    this.db()
      .prepare(
        "DELETE FROM processed_conversation_run_events WHERE processed_at < ?",
      )
      .run(cutoff.toISOString());
  }

  eventsAfter(conversationId: string, sequence: number): ConversationEvent[] {
    return this.many<ConversationEvent>(
      `
        SELECT payload_json FROM conversation_events
        WHERE conversation_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `,
      conversationId,
      sequence,
    );
  }

  detail(id: string): ConversationDetail | undefined {
    const conversation = this.get(id);
    return conversation
      ? {
          conversation,
          messages: this.listMessages(id),
          activities: this.listActivities(id),
        }
      : undefined;
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("conversation store is not initialized");
    return this.database;
  }

  private one<T>(
    sql: string,
    ...parameters: Array<string | number>
  ): T | undefined {
    const row = this.db()
      .prepare(sql)
      .get(...parameters) as unknown as PayloadRow | undefined;
    return row ? (JSON.parse(row.payload_json) as T) : undefined;
  }

  private many<T>(
    sql: string,
    ...parameters: Array<string | number>
  ): T[] {
    const rows = this.db()
      .prepare(sql)
      .all(...parameters) as unknown as PayloadRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as T);
  }
}
