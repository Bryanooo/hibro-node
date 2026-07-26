import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { RunEvent, RunRecord } from "./domain.ts";
import type {
  Conversation,
  ConversationActivity,
  ConversationDetail,
  ConversationEvent,
  ConversationMessage,
  ConversationSource,
} from "./conversation-domain.ts";
import { ConversationStore } from "./conversation-store.ts";
import type { RunManager } from "./run-manager.ts";

export interface CreateConversationInput {
  id?: string;
  title?: string;
  agentId: string;
  source?: ConversationSource;
  createdBy?: string;
}

export interface SendConversationMessageInput {
  content: string;
  userMessageId?: string;
  assistantMessageId?: string;
  createdBy?: string;
}

type ConversationListener = (event: ConversationEvent) => void;

export class ConversationService {
  private readonly events = new EventEmitter();
  private unsubscribeRuns?: () => void;
  private processing = Promise.resolve();
  private readonly pendingMessages = new Set<string>();
  readonly store: ConversationStore;
  private readonly manager: RunManager;

  constructor(store: ConversationStore, manager: RunManager) {
    this.store = store;
    this.manager = manager;
    this.events.setMaxListeners(200);
  }

  async init(): Promise<void> {
    await this.store.init();
    this.store.pruneProcessedRunEvents(
      new Date(
        Date.now() -
          this.manager.getSettings().eventRetentionDays * 24 * 60 * 60 * 1_000,
      ),
    );
    this.unsubscribeRuns = this.manager.subscribeAll((event) => {
      this.processing = this.processing
        .then(() => this.consumeRunEvent(event))
        .catch(() => undefined);
    });
    await this.reconcileActiveConversations();
  }

  async close(): Promise<void> {
    this.unsubscribeRuns?.();
    await this.processing;
    await this.store.close();
  }

  list(): Conversation[] {
    return this.store.list();
  }

  detail(id: string): ConversationDetail | undefined {
    return this.store.detail(id);
  }

  create(input: CreateConversationInput): ConversationDetail {
    const agent = this.manager.agents?.get(input.agentId);
    if (!agent) throw new Error(`Agent not found: ${input.agentId}`);
    if (!agent.enabled) throw new Error(`Agent ${input.agentId} is disabled`);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: input.id?.trim() || `conv_${randomUUID()}`,
      title: input.title?.trim() || agent.name,
      agentId: agent.id,
      engine: agent.engine,
      status: "idle",
      source: input.source ?? "node",
      createdBy: input.createdBy?.trim() || "hibro-node",
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(conversation);
    this.publish(conversation.id, "conversation.created", { conversation });
    return this.requiredDetail(conversation.id);
  }

  async sendMessage(
    conversationId: string,
    input: SendConversationMessageInput,
  ): Promise<ConversationDetail> {
    const conversation = this.requiredDetail(conversationId).conversation;
    if (
      input.userMessageId?.trim() &&
      this.store.getMessage(input.userMessageId.trim())
    ) {
      return this.requiredDetail(conversationId);
    }
    if (conversation.status === "archived") {
      throw new Error("Conversation is archived");
    }
    if (conversation.activeRunId || this.pendingMessages.has(conversationId)) {
      throw new Error("Agent is already responding in this conversation");
    }
    const content = input.content?.trim();
    if (!content) throw new Error("content is required");
    this.pendingMessages.add(conversationId);
    const now = new Date().toISOString();
    const userMessage: ConversationMessage = {
      id: input.userMessageId?.trim() || `msg_${randomUUID()}`,
      conversationId,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
      updatedAt: now,
    };
    const assistantMessage: ConversationMessage = {
      id: input.assistantMessageId?.trim() || `msg_${randomUUID()}`,
      conversationId,
      role: "assistant",
      content: "",
      status: "queued",
      createdAt: new Date(Date.now() + 1).toISOString(),
      updatedAt: now,
    };
    this.store.createMessage(userMessage);
    this.store.createMessage(assistantMessage);
    this.publish(conversationId, "message.created", { message: userMessage });
    this.publish(conversationId, "message.created", { message: assistantMessage });

    try {
      const run = await this.manager.create({
        agentId: conversation.agentId,
        prompt: content,
        sessionKey: conversation.id,
        metadata: {
          conversationId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          createdBy: input.createdBy ?? conversation.createdBy,
        },
      });
      assistantMessage.runId = run.id;
      assistantMessage.status = "streaming";
      assistantMessage.updatedAt = new Date().toISOString();
      this.store.saveMessage(assistantMessage);
      conversation.activeRunId = run.id;
      conversation.status = "responding";
      conversation.lastMessageAt = now;
      conversation.updatedAt = now;
      this.store.save(conversation);
      this.publish(conversationId, "message.updated", { message: assistantMessage });
      this.publish(conversationId, "conversation.updated", { conversation });
      for (const event of await this.manager.eventsAfter(run.id)) {
        await this.consumeRunEvent(event);
      }
    } catch (error) {
      assistantMessage.status = "failed";
      assistantMessage.error = error instanceof Error ? error.message : String(error);
      assistantMessage.updatedAt = new Date().toISOString();
      this.store.saveMessage(assistantMessage);
      conversation.status = "error";
      conversation.updatedAt = assistantMessage.updatedAt;
      this.store.save(conversation);
      this.publish(conversationId, "message.updated", { message: assistantMessage });
      this.publish(conversationId, "conversation.updated", { conversation });
      throw error;
    } finally {
      this.pendingMessages.delete(conversationId);
    }
    return this.requiredDetail(conversationId);
  }

  async cancel(conversationId: string): Promise<ConversationDetail> {
    const conversation = this.requiredDetail(conversationId).conversation;
    if (conversation.activeRunId) {
      await this.manager.cancel(conversation.activeRunId);
    }
    return this.requiredDetail(conversationId);
  }

  rename(conversationId: string, title: string): ConversationDetail {
    const conversation = this.requiredDetail(conversationId).conversation;
    if (!title.trim()) throw new Error("title is required");
    conversation.title = title.trim();
    conversation.updatedAt = new Date().toISOString();
    this.store.save(conversation);
    this.publish(conversationId, "conversation.updated", { conversation });
    return this.requiredDetail(conversationId);
  }

  archive(conversationId: string): ConversationDetail {
    const conversation = this.requiredDetail(conversationId).conversation;
    if (conversation.activeRunId) throw new Error("Cannot archive an active conversation");
    conversation.status = "archived";
    conversation.updatedAt = new Date().toISOString();
    this.store.save(conversation);
    this.publish(conversationId, "conversation.updated", { conversation });
    return this.requiredDetail(conversationId);
  }

  async decideApproval(
    conversationId: string,
    activityId: string,
    decision: "allow_once" | "allow_always" | "deny",
  ): Promise<ConversationDetail> {
    const activity = this.store.getActivity(activityId);
    if (!activity || activity.conversationId !== conversationId) {
      throw new Error("Approval not found");
    }
    if (activity.type !== "approval") throw new Error("Activity is not an approval");
    if (!activity.approval?.resolvable || !activity.runId) {
      throw new Error(
        activity.approval?.reason ||
          "This engine adapter exposes the approval event as read-only",
      );
    }
    if (!activity.approval.decisions.includes(decision)) {
      throw new Error("Unsupported approval decision");
    }
    await this.manager.decideApproval(
      activity.runId,
      activity.approval.externalId ?? activity.id,
      decision,
    );
    return this.requiredDetail(conversationId);
  }

  eventsAfter(conversationId: string, sequence = 0): ConversationEvent[] {
    this.requiredDetail(conversationId);
    return this.store.eventsAfter(conversationId, sequence);
  }

  subscribe(conversationId: string, listener: ConversationListener): () => void {
    this.events.on(conversationId, listener);
    return () => this.events.off(conversationId, listener);
  }

  capabilities(): Record<string, unknown> {
    return {
      realtime: "sse",
      activityTypes: [
        "thinking",
        "tool_call",
        "tool_result",
        "approval",
        "progress",
        "error",
      ],
      approvals: {
        model: "provider-capability",
        writableProviders: ["claude-code", "codex", "openclaw"],
        note:
          "Claude uses a blocking PreToolUse hook, Codex uses app-server JSON-RPC, and OpenClaw uses the Hibro execution gate.",
      },
      engines: {
        "claude-code": {
          messages: true,
          thinking: "when-emitted-by-engine",
          tools: true,
          approvalEvents: "writable",
        },
        codex: {
          messages: true,
          thinking: "when-emitted-by-engine",
          tools: true,
          approvalEvents: "writable",
        },
        openclaw: {
          messages: true,
          thinking: "when-emitted-by-engine",
          tools: "when-emitted-by-cli",
          approvalEvents: "writable-preflight",
        },
      },
    };
  }

  private requiredDetail(id: string): ConversationDetail {
    const detail = this.store.detail(id);
    if (!detail) throw new Error(`Conversation not found: ${id}`);
    return detail;
  }

  private publish(
    conversationId: string,
    type: ConversationEvent["type"],
    payload: Record<string, unknown>,
  ): ConversationEvent {
    const event = this.store.appendEvent({
      conversationId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
    if (!event) throw new Error("Failed to append conversation event");
    this.events.emit(conversationId, event);
    this.events.emit("*", event);
    return event;
  }

  private contextFor(run: RunRecord): {
    conversationId: string;
    assistantMessageId: string;
  } | undefined {
    const metadata = run.request.metadata;
    const conversationId = metadata?.conversationId;
    const assistantMessageId = metadata?.assistantMessageId;
    return typeof conversationId === "string" &&
      typeof assistantMessageId === "string"
      ? { conversationId, assistantMessageId }
      : undefined;
  }

  private async consumeRunEvent(event: RunEvent): Promise<void> {
    const sourceKey = `${event.runId}:${event.sequence}`;
    if (!this.store.claimRunEvent(sourceKey)) return;
    const run = await this.manager.get(event.runId);
    if (!run) return;
    const context = this.contextFor(run);
    if (!context || !this.store.get(context.conversationId)) return;
    const message = this.store.getMessage(context.assistantMessageId);
    if (!message) return;

    if (event.type === "run.completed" || event.type === "run.failed") {
      await this.finishRun(run, event, message);
      return;
    }
    this.normalizeEngineEvent(run, event, message);
  }

  private async reconcileActiveConversations(): Promise<void> {
    for (const conversation of this.store.list()) {
      if (!conversation.activeRunId) continue;
      const run = await this.manager.get(conversation.activeRunId);
      const detail = this.store.detail(conversation.id);
      const message = detail?.messages.find(
        (item) => item.runId === conversation.activeRunId && item.role === "assistant",
      );
      if (!run || !message) {
        conversation.activeRunId = undefined;
        conversation.status = "error";
        conversation.updatedAt = new Date().toISOString();
        this.store.save(conversation);
        if (message) {
          message.status = "failed";
          message.error = "Node restarted before the active run could be recovered";
          message.updatedAt = conversation.updatedAt;
          this.store.saveMessage(message);
        }
        this.publish(conversation.id, "conversation.updated", { conversation });
        continue;
      }
      if (["completed", "failed", "cancelled", "timed_out"].includes(run.status)) {
        const events = await this.manager.eventsAfter(run.id);
        const terminal =
          [...events]
            .reverse()
            .find((event) =>
              event.type === "run.completed" || event.type === "run.failed"
            ) ?? {
            runId: run.id,
            sequence: events.at(-1)?.sequence ?? 0,
            type: run.status === "completed" ? "run.completed" : "run.failed",
            timestamp: run.finishedAt ?? run.updatedAt,
            payload: { recovered: true },
          };
        await this.finishRun(run, terminal, message);
      } else {
        for (const event of await this.manager.eventsAfter(run.id)) {
          await this.consumeRunEvent(event);
        }
      }
    }
  }

  private async finishRun(
    run: RunRecord,
    event: RunEvent,
    message: ConversationMessage,
  ): Promise<void> {
    const conversation = this.requiredDetail(message.conversationId).conversation;
    const failed = event.type === "run.failed" || run.status !== "completed";
    if (!failed && run.result) message.content = run.result;
    message.status = failed ? "failed" : "completed";
    message.error = failed ? run.error?.message || `Run ${run.status}` : undefined;
    message.updatedAt = new Date().toISOString();
    this.store.saveMessage(message);
    conversation.activeRunId = undefined;
    conversation.status = failed ? "error" : "idle";
    conversation.engineSessionId = run.sessionId;
    conversation.lastMessageAt = message.updatedAt;
    conversation.updatedAt = message.updatedAt;
    this.store.save(conversation);
    this.publish(conversation.id, "message.updated", { message });
    this.publish(conversation.id, "conversation.updated", { conversation });
    for (const activity of this.store
      .listActivities(conversation.id)
      .filter(
        (item) =>
          item.runId === run.id &&
          item.status === "running" &&
          item.type !== "approval",
      )) {
      activity.status = failed ? "failed" : "completed";
      activity.updatedAt = message.updatedAt;
      this.upsertActivity(activity);
    }
    if (failed) {
      this.upsertActivity({
        id: `activity_${run.id}_error`,
        conversationId: conversation.id,
        messageId: message.id,
        runId: run.id,
        type: "error",
        status: "failed",
        title: "Agent 执行失败",
        detail: message.error,
        payload: { status: run.status, error: run.error },
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }
  }

  private normalizeEngineEvent(
    run: RunRecord,
    event: RunEvent,
    message: ConversationMessage,
  ): void {
    const payload = event.payload;
    const raw = record(payload.raw) ?? record(payload.event) ?? payload;
    const rawType = string(raw.type) || event.type;
    const item = record(raw.item);
    const itemType = string(item?.type) || string(raw.item_type) || "";

    if (event.type === "engine.approval.requested") {
      const request = record(payload.request) ?? {};
      const externalId = string(payload.externalId) || string(request.externalId);
      this.upsertActivity({
        id: `activity_${run.id}_approval_${safeId(externalId || String(event.sequence))}`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: "approval",
        status: "pending",
        title: string(request.title) || "Agent 请求审批",
        detail: string(request.detail) || string(request.command),
        payload: request,
        approval: {
          provider: run.engine,
          externalId,
          decisions: Array.isArray(request.decisions)
            ? (request.decisions as Array<"allow_once" | "allow_always" | "deny">)
            : ["allow_once", "allow_always", "deny"],
          resolvable: true,
          reason: string(request.reason) || undefined,
        },
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
      return;
    }
    if (event.type === "engine.approval.resolved") {
      const externalId = string(payload.externalId);
      const activity = this.store
        .listActivities(message.conversationId)
        .find(
          (candidate) =>
            candidate.runId === run.id &&
            candidate.type === "approval" &&
            candidate.approval?.externalId === externalId,
        );
      if (activity) {
        const decision = string(payload.decision) as
          | "allow_once"
          | "allow_always"
          | "deny";
        activity.status = decision === "deny" ? "denied" : "completed";
        if (activity.approval) activity.approval.decision = decision;
        activity.updatedAt = event.timestamp;
        this.upsertActivity(activity);
      }
      return;
    }

    if (event.type === "assistant.message") {
      const text = extractText(payload.message) || string(payload.text) || string(payload.result);
      if (text) this.updateAssistant(message, text, false);
      this.normalizeContentBlocks(run, event, message, payload.message);
      return;
    }
    if (event.type === "engine.user_message") {
      this.normalizeContentBlocks(run, event, message, payload.message);
    }

    const delta = record(raw.delta);
    if (string(delta?.type) === "text_delta" && typeof delta?.text === "string") {
      this.updateAssistant(message, delta.text, true);
    }
    if (string(delta?.type) === "thinking_delta" && typeof delta?.thinking === "string") {
      this.appendActivityDetail(
        `activity_${run.id}_thinking_${number(raw.index)}`,
        run,
        message,
        "thinking",
        "Agent 思考",
        delta.thinking,
        event.timestamp,
      );
    }
    if (
      string(delta?.type) === "input_json_delta" &&
      typeof delta?.partial_json === "string"
    ) {
      this.appendActivityDetail(
        `activity_${run.id}_tool_${number(raw.index)}`,
        run,
        message,
        "tool_call",
        "准备工具参数",
        delta.partial_json,
        event.timestamp,
      );
    }

    const block = record(raw.content_block);
    if (rawType === "content_block_start" && block) {
      this.normalizeContentBlock(run, event, message, block, number(raw.index));
    }
    if (rawType === "content_block_stop") {
      const activity =
        this.store.getActivity(`activity_${run.id}_tool_${number(raw.index)}`) ??
        this.store.getActivity(`activity_${run.id}_thinking_${number(raw.index)}`);
      if (activity) {
        activity.status = "completed";
        activity.updatedAt = event.timestamp;
        this.upsertActivity(activity);
      }
    }

    const toolLike =
      /tool|command|mcp|file_change|web_search|computer/i.test(itemType) ||
      /tool|command|mcp/i.test(rawType);
    if (toolLike) {
      const status = /failed|error/i.test(string(item?.status) || rawType)
        ? "failed"
        : /completed|result|finished/i.test(string(item?.status) || rawType)
          ? "completed"
          : "running";
      this.upsertActivity({
        id: `activity_${run.id}_${string(item?.id) || event.sequence}`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: /result|output/i.test(rawType) ? "tool_result" : "tool_call",
        status,
        title:
          string(item?.name) ||
          string(item?.command) ||
          itemType ||
          "工具调用",
        detail:
          string(item?.text) ||
          string(item?.aggregated_output) ||
          stringifyCompact(item ?? raw),
        payload: item ?? raw,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }

    if (/approval|permission/i.test(`${event.type} ${rawType} ${itemType}`)) {
      this.upsertActivity({
        id: `activity_${run.id}_approval_${string(item?.id) || event.sequence}`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: "approval",
        status: /denied|reject|failed/i.test(string(item?.status) || rawType)
          ? "denied"
          : "pending",
        title: string(item?.name) || "Agent 请求审批",
        detail: stringifyCompact(item ?? raw),
        payload: item ?? raw,
        approval: {
          provider: run.engine,
          externalId: string(item?.id),
          decisions: ["allow_once", "allow_always", "deny"],
          resolvable: false,
          reason:
            "当前 CLI 适配器没有提供可恢复的审批通道；此项只用于完整呈现引擎事件。",
        },
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }

    if (/turn\.started|run\.started|session\.started|progress/i.test(event.type)) {
      this.upsertActivity({
        id: `activity_${run.id}_progress`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: "progress",
        status: "running",
        title: "Agent 正在处理",
        detail: event.type,
        payload,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }
  }

  private normalizeContentBlocks(
    run: RunRecord,
    event: RunEvent,
    message: ConversationMessage,
    value: unknown,
  ): void {
    const source = record(value);
    const blocks = Array.isArray(source?.content) ? source.content : [];
    blocks.forEach((candidate, index) => {
      const block = record(candidate);
      if (block) this.normalizeContentBlock(run, event, message, block, index);
    });
  }

  private normalizeContentBlock(
    run: RunRecord,
    event: RunEvent,
    message: ConversationMessage,
    block: Record<string, unknown>,
    index: number,
  ): void {
    const type = string(block.type);
    if (type === "thinking") {
      this.upsertActivity({
        id: `activity_${run.id}_thinking_${index}`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: "thinking",
        status: "completed",
        title: "Agent 思考",
        detail: string(block.thinking) || string(block.text),
        payload: block,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }
    if (type === "tool_use") {
      this.upsertActivity({
        id: `activity_${run.id}_tool_${index}`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: "tool_call",
        status: "running",
        title: string(block.name) || "工具调用",
        detail: stringifyCompact(block.input),
        payload: block,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }
    if (type === "tool_result") {
      this.upsertActivity({
        id: `activity_${run.id}_tool_result_${index}`,
        conversationId: message.conversationId,
        messageId: message.id,
        runId: run.id,
        type: "tool_result",
        status: string(block.is_error) === "true" ? "failed" : "completed",
        title: "工具结果",
        detail: extractText(block.content) || stringifyCompact(block.content),
        payload: block,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      });
    }
  }

  private updateAssistant(
    message: ConversationMessage,
    text: string,
    append: boolean,
  ): void {
    message.content = append ? `${message.content}${text}` : text;
    message.status = "streaming";
    message.updatedAt = new Date().toISOString();
    this.store.saveMessage(message);
    this.publish(message.conversationId, "message.updated", { message });
  }

  private appendActivityDetail(
    id: string,
    run: RunRecord,
    message: ConversationMessage,
    type: "thinking" | "tool_call",
    title: string,
    delta: string,
    timestamp: string,
  ): void {
    const current = this.store.getActivity(id);
    this.upsertActivity({
      id,
      conversationId: message.conversationId,
      messageId: message.id,
      runId: run.id,
      type,
      status: "running",
      title,
      detail: `${current?.detail ?? ""}${delta}`,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  private upsertActivity(activity: ConversationActivity): void {
    const exists = this.store.getActivity(activity.id);
    this.store.upsertActivity(activity);
    this.publish(activity.conversationId, exists ? "activity.updated" : "activity.created", {
      activity,
    });
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringifyCompact(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        const block = record(item);
        return string(block?.text);
      })
      .filter(Boolean)
      .join("");
  }
  const object = record(value);
  if (!object) return "";
  if (typeof object.text === "string") return object.text;
  if (Array.isArray(object.content)) return extractText(object.content);
  return "";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
}
