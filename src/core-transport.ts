import { createReadStream } from "node:fs";
import { arch, platform } from "node:os";
import WebSocket from "ws";
import {
  createCoreEnvelope,
  parseCoreEnvelope,
  type HibroCoreMessage,
} from "./core-protocol.ts";
import { isTerminalStatus, type RunEvent, type RunRecord } from "./domain.ts";
import type { RunManager } from "./run-manager.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { ConversationEvent } from "./conversation-domain.ts";
import type { ArtifactRecord } from "./domain.ts";
import { createId } from "./identity.ts";

export class CoreTransport {
  private readonly manager: RunManager;
  private socket: WebSocket | undefined;
  private stopped = false;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private outboxTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private sequence = 0;
  private incomingSequence = 0;
  private processing = Promise.resolve();
  private resumeToken: string | undefined;
  private instanceId = createId("inst");
  private lastFingerprint = "";
  private artifactSyncRequired = true;
  private readonly uploadingArtifacts = new Set<string>();
  private unsubscribe?: () => void;
  private unsubscribeConversations: (() => void) | undefined;
  private readonly conversations: ConversationService | undefined;

  constructor(manager: RunManager, conversations?: ConversationService) {
    this.manager = manager;
    this.conversations = conversations;
  }

  start(): void {
    if (this.reconcileTimer) return;
    this.stopped = false;
    this.unsubscribe = this.manager.subscribeAll((event) => {
      void this.forwardRunEvent(event);
    });
    this.unsubscribeConversations = this.conversations?.subscribe(
      "*",
      (event) => this.forwardConversationEvent(event),
    );
    this.reconcileTimer = setInterval(() => this.reconcile(), 3_000);
    this.reconcileTimer.unref();
    this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.unsubscribe?.();
    this.unsubscribeConversations?.();
    this.socket?.close(1001, "Node shutdown");
  }

  private reconcile(): void {
    if (this.stopped) return;
    const settings = this.manager.getSettings();
    const fingerprint = JSON.stringify({
      enabled: settings.coreEnabled,
      url: settings.coreUrl,
      token: settings.coreToken,
      nodeId: settings.nodeId,
    });
    if (!settings.coreEnabled) {
      this.lastFingerprint = fingerprint;
      if (this.socket) this.socket.close(1000, "Core disabled");
      this.manager.setCoreConnection({
        connected: false,
        status: "standalone",
        error: undefined,
      });
      return;
    }
    if (
      fingerprint === this.lastFingerprint &&
      this.socket &&
      (this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    this.lastFingerprint = fingerprint;
    this.socket?.close(1000, "Core settings changed");
    this.connect();
  }

  private connect(): void {
    const settings = this.manager.getSettings();
    if (!settings.coreEnabled || !settings.coreUrl || !settings.coreToken || this.stopped) return;
    this.manager.setCoreConnection({
      connected: false,
      status: "connecting",
      error: undefined,
    });
    const url = new URL(settings.coreUrl);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.pathname === "/" || !url.pathname) url.pathname = "/v1/node-connect";
    const socket = new WebSocket(url, "hibro.node.v1", {
      headers: { Authorization: `Bearer ${settings.coreToken}` },
      handshakeTimeout: 10_000,
      maxPayload: 1_048_576,
    });
    this.socket = socket;
    socket.on("open", () => {
      this.sequence = 0;
      this.incomingSequence = 0;
      this.manager.setCoreConnection({
        connected: false,
        status: "connecting",
        error: undefined,
      });
      void this.sendHello();
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(4400, "binary frames are not supported");
        return;
      }
      const raw = data.toString();
      this.processing = this.processing.then(() => this.handle(raw)).catch((error) => {
        try {
          const source = parseCoreEnvelope(JSON.parse(raw));
          const retryable = /concurrency limit|already responding|temporar|busy/i.test(
            error instanceof Error ? error.message : String(error),
          );
          this.send(
            "message.error",
            {
              messageId: source.messageId,
              code: "command_failed",
              message: error instanceof Error ? error.message : String(error),
              retryable,
            },
            {
              correlationId: source.correlationId,
              causationId: source.messageId,
            },
          );
        } catch {
          // Invalid frames cannot be correlated with a source command.
        }
        this.manager.setCoreConnection({
          connected: false,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    socket.on("close", (code, reason) => {
      const wasCurrent = this.socket === socket;
      process.stderr.write(
        `${JSON.stringify({
          type: "core.connection.closed",
          code,
          reason: reason.toString(),
        })}\n`,
      );
      if (!wasCurrent) return;
      this.socket = undefined;
      this.artifactSyncRequired = true;
      this.stopTimers();
      if (!this.stopped && this.manager.getSettings().coreEnabled) {
        this.manager.setCoreConnection({
          connected: false,
          status: "error",
          error: reason.toString() || "Hibro Core connection closed",
        });
        this.scheduleReconnect();
      }
    });
    socket.on("error", (error) => {
      this.manager.setCoreConnection({
        connected: false,
        status: "error",
        error: error.message,
      });
    });
  }

  private async handle(raw: string): Promise<void> {
    const message = parseCoreEnvelope(JSON.parse(raw));
    if (message.sequence !== undefined) {
      if (
        !Number.isInteger(message.sequence) ||
        message.sequence <= this.incomingSequence
      ) {
        throw new Error("Core message sequence is not strictly increasing");
      }
      this.incomingSequence = message.sequence;
    }
    this.manager.setCoreConnection({ lastMessageAt: new Date().toISOString() });
    const trackedCommand =
      message.requiresAck === true &&
      !["core.welcome", "core.heartbeat", "message.ack", "message.error"].includes(
        message.type,
      );
    if (
      trackedCommand &&
      this.manager.store.hasProcessedCoreCommand(message.messageId)
    ) {
      this.send(
        "message.ack",
        {
          messageId: message.messageId,
          accepted: true,
          status: "duplicate",
          persistedAt: new Date().toISOString(),
        },
        {
          correlationId: message.correlationId,
          causationId: message.messageId,
        },
      );
      return;
    }
    switch (message.type) {
      case "core.welcome": {
        const payload = message.payload as {
          heartbeatIntervalMs?: number;
          resumeToken?: string;
          authentication?: {
            enrolled?: boolean;
            credentialId?: string;
            nodeCredential?: string;
          };
        };
        this.resumeToken = payload.resumeToken;
        if (
          payload.authentication?.enrolled &&
          payload.authentication.nodeCredential
        ) {
          await this.manager.updateSettings({
            coreToken: payload.authentication.nodeCredential,
          });
        }
        const now = new Date().toISOString();
        this.manager.setCoreConnection({
          connected: true,
          status: "connected",
          connectedAt: now,
          lastMessageAt: now,
          error: undefined,
        });
        await this.sendSnapshot();
        this.startTimers(payload.heartbeatIntervalMs ?? 15_000);
        break;
      }
      case "core.heartbeat":
        await this.sendHeartbeat();
        break;
      case "agent.registration": {
        const payload = message.payload as {
          agentId: string;
          status: "registered" | "rejected" | "error";
          coreAgentId?: string;
          error?: { message?: string };
        };
        this.manager.setCoreRegistration(payload.agentId, {
          status: payload.status,
          coreAgentId: payload.coreAgentId,
          registeredAt:
            payload.status === "registered" ? new Date().toISOString() : undefined,
          lastSyncedAt: new Date().toISOString(),
          error: payload.error?.message,
        });
        break;
      }
      case "run.create":
        await this.handleRunCreate(message);
        break;
      case "run.cancel":
        await this.handleRunCancel(message);
        break;
      case "run.approval.decide":
        await this.handleRunApprovalDecision(message);
        break;
      case "settings.patch":
        await this.handleSettingsPatch(message);
        break;
      case "conversation.create":
        await this.handleConversationCreate(message);
        break;
      case "conversation.message.create":
        await this.handleConversationMessageCreate(message);
        break;
      case "conversation.cancel":
        await this.handleConversationCancel(message);
        break;
      case "conversation.approval.decide":
        await this.handleConversationApprovalDecision(message);
        break;
      case "artifact.upload.authorized":
        await this.handleArtifactUploadAuthorized(message);
        break;
      case "message.ack":
        this.acknowledgeSourceMessage(message);
        break;
      case "message.error":
        if (
          (message.payload as { retryable?: boolean }).retryable === false
        ) {
          this.acknowledgeSourceMessage(message, true);
        }
        break;
      default:
        break;
    }
    if (trackedCommand) {
      this.manager.store.rememberProcessedCoreCommand(message.messageId);
    }
    if (message.requiresAck) {
      this.send(
        "message.ack",
        {
          messageId: message.messageId,
          accepted: true,
          status: "accepted",
          persistedAt: new Date().toISOString(),
        },
        {
          correlationId: message.correlationId,
          causationId: message.messageId,
        },
      );
    }
  }

  private async sendHello(): Promise<void> {
    const settings = this.manager.getSettings();
    const engines = await this.manager.doctorEngines();
    this.send("node.hello", {
      node: {
        nodeId: settings.nodeId,
        nodeName: settings.nodeName,
        instanceId: this.instanceId,
        version: "0.1.0",
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        platform: platform(),
        arch: arch(),
      },
      authentication: { method: "node-token" },
      resumeToken: this.resumeToken,
      protocol: { supported: ["hibro.node.v1"], preferred: "hibro.node.v1" },
      capabilities: {
        engines: engines.map(({ id, doctor }) => ({
          id,
          version: doctor.version,
          ready: doctor.ready,
        })),
        transports: ["websocket"],
        features: [
          "agent-registration",
          "remote-runs",
          "run-events",
          "inline-artifacts",
          "object-storage-artifacts",
          "conversations",
          "conversation-events",
          "conversation-approvals",
        ],
        maxFrameBytes: 1_048_576,
      },
    });
  }

  private async sendSnapshot(): Promise<void> {
    const settings = this.manager.getSettings();
    const runs = await this.manager.list();
    this.send(
      "node.snapshot",
      {
        generatedAt: new Date().toISOString(),
        settings: {
          nodeName: settings.nodeName,
          maxConcurrentRuns: settings.maxConcurrentRuns,
          defaultTimeoutMs: settings.defaultTimeoutMs,
          coreEnabled: settings.coreEnabled,
        },
        agents: await this.manager.listAgents(),
        activeRuns: runs.filter((run) => !isTerminalStatus(run.status)),
      },
      { requiresAck: true },
    );
    for (const conversation of this.conversations?.list() ?? []) {
      const detail = this.conversations?.detail(conversation.id);
      if (detail) {
        this.send(
          "conversation.snapshot",
          { conversation: detail },
          { requiresAck: true, correlationId: conversation.id },
        );
      }
    }
    if (this.artifactSyncRequired) {
      this.artifactSyncRequired = false;
      for (const run of runs.filter((candidate) => isTerminalStatus(candidate.status))) {
        this.send(
          "run.snapshot",
          { run },
          { correlationId: run.id, requiresAck: true },
        );
      }
      for (const artifact of await this.manager.listArtifacts()) {
        this.forwardArtifact(artifact, true);
      }
    } else {
      for (const artifact of await this.manager.listArtifacts()) {
        if (artifact.sync?.status === "failed") this.forwardArtifact(artifact);
      }
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const agents = await this.manager.listAgents();
    this.send("node.heartbeat", {
      observedAt: new Date().toISOString(),
      activeRuns: this.manager.activeRunCount(),
      queuedRuns: 0,
      agentCount: agents.length,
    });
  }

  private async handleRunCreate(message: HibroCoreMessage): Promise<void> {
    const payload = message.payload as unknown as {
      commandId: string;
      agentId: string;
      request: Record<string, unknown>;
    };
    const existing = (await this.manager.list()).find(
      (run) => run.request.metadata?.coreCommandId === payload.commandId,
    );
    const run =
      existing ??
      (await this.manager.create({
        ...(payload.request as unknown as Parameters<RunManager["create"]>[0]),
        agentId: payload.agentId,
        metadata: {
          ...((payload.request.metadata as Record<string, unknown> | undefined) ?? {}),
          coreCommandId: payload.commandId,
        },
      }));
    this.send(
      "run.accepted",
      {
        commandId: payload.commandId,
        runId: run.id,
        acceptedAt: new Date().toISOString(),
      },
      { correlationId: message.correlationId, causationId: message.messageId },
    );
    this.send(
      "run.snapshot",
      { run },
      { correlationId: message.correlationId, requiresAck: true },
    );
  }

  private async handleRunCancel(message: HibroCoreMessage): Promise<void> {
    const payload = message.payload as { runId: string };
    const run = await this.manager.cancel(payload.runId);
    if (run) {
      this.send(
        "run.snapshot",
        { run },
        { correlationId: message.correlationId, requiresAck: true },
      );
    }
  }

  private async handleRunApprovalDecision(
    message: HibroCoreMessage,
  ): Promise<void> {
    const payload = message.payload as {
      runId: string;
      externalId: string;
      decision: "allow_once" | "allow_always" | "deny";
    };
    await this.manager.decideApproval(
      payload.runId,
      payload.externalId,
      payload.decision,
    );
  }

  private async handleSettingsPatch(message: HibroCoreMessage): Promise<void> {
    const payload = message.payload as { patch?: Record<string, unknown> };
    await this.manager.updateSettings(payload.patch ?? {});
  }

  private async handleConversationCreate(
    message: HibroCoreMessage,
  ): Promise<void> {
    if (!this.conversations) throw new Error("Conversation service is unavailable");
    const payload = message.payload as {
      conversationId: string;
      agentId: string;
      title?: string;
      requestedBy?: { userId?: string };
    };
    const existing = this.conversations.detail(payload.conversationId);
    const detail =
      existing ??
      this.conversations.create({
        id: payload.conversationId,
        agentId: payload.agentId,
        source: "core",
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.requestedBy?.userId
          ? { createdBy: payload.requestedBy.userId }
          : {}),
      });
    this.send(
      "conversation.snapshot",
      { conversation: detail },
      {
        correlationId: message.correlationId ?? payload.conversationId,
        causationId: message.messageId,
        requiresAck: true,
      },
    );
  }

  private async handleConversationMessageCreate(
    message: HibroCoreMessage,
  ): Promise<void> {
    if (!this.conversations) throw new Error("Conversation service is unavailable");
    const payload = message.payload as {
      conversationId: string;
      content: string;
      userMessageId: string;
      assistantMessageId: string;
      requestedBy?: { userId?: string };
    };
    const detail = await this.conversations.sendMessage(payload.conversationId, {
      content: payload.content,
      userMessageId: payload.userMessageId,
      assistantMessageId: payload.assistantMessageId,
      ...(payload.requestedBy?.userId
        ? { createdBy: payload.requestedBy.userId }
        : {}),
    });
    this.send(
      "conversation.snapshot",
      { conversation: detail },
      {
        correlationId: message.correlationId ?? payload.conversationId,
        causationId: message.messageId,
        requiresAck: true,
      },
    );
  }

  private async handleConversationCancel(
    message: HibroCoreMessage,
  ): Promise<void> {
    if (!this.conversations) throw new Error("Conversation service is unavailable");
    const payload = message.payload as { conversationId: string };
    const detail = await this.conversations.cancel(payload.conversationId);
    this.send(
      "conversation.snapshot",
      { conversation: detail },
      {
        correlationId: message.correlationId ?? payload.conversationId,
        causationId: message.messageId,
        requiresAck: true,
      },
    );
  }

  private async handleConversationApprovalDecision(
    message: HibroCoreMessage,
  ): Promise<void> {
    if (!this.conversations) throw new Error("Conversation service is unavailable");
    const payload = message.payload as {
      conversationId: string;
      activityId: string;
      decision: "allow_once" | "allow_always" | "deny";
    };
    const detail = await this.conversations.decideApproval(
      payload.conversationId,
      payload.activityId,
      payload.decision,
    );
    this.send(
      "conversation.snapshot",
      { conversation: detail },
      {
        correlationId: message.correlationId ?? payload.conversationId,
        causationId: message.messageId,
        requiresAck: true,
      },
    );
  }

  private forwardConversationEvent(event: ConversationEvent): void {
    this.send(
      "conversation.event",
      { event },
      { requiresAck: true, correlationId: event.conversationId },
    );
  }

  private async forwardRunEvent(event: RunEvent): Promise<void> {
    const run = await this.manager.get(event.runId);
    if (!run) return;
    this.send("run.event", { event }, { requiresAck: true, correlationId: event.runId });
    this.send(
      "run.snapshot",
      { run },
      { correlationId: event.runId, requiresAck: true },
    );
    if (event.type === "run.completed") {
      const artifacts = (await this.manager.listArtifacts()).filter(
        (candidate) => candidate.runId === run.id,
      );
      for (const artifact of artifacts) {
        this.forwardArtifact(artifact);
      }
    }
  }

  private forwardArtifact(
    artifact: ArtifactRecord,
    retryPending = false,
  ): void {
    const settings = this.manager.getSettings();
    if (!settings.coreEnabled || !settings.coreUrl) return;
    const existing = this.manager.getArtifactSyncRecord(artifact.id);
    if (
      existing &&
      existing.sha256 === artifact.sha256 &&
      existing.targetCore === settings.coreUrl &&
      (["uploading", "synced"].includes(existing.status) ||
        (existing.status === "pending" && !retryPending))
    ) {
      return;
    }
    const messageId = this.send(
      "artifact.manifest",
      {
        artifact: {
          ...artifact,
          content: undefined,
          localPath: undefined,
          sync: undefined,
          contentType: artifact.contentType ?? "text/markdown",
          sizeBytes:
            artifact.sizeBytes ??
            Buffer.byteLength(artifact.content ?? "", artifact.encoding === "base64" ? "base64" : "utf8"),
        },
        transfer: { mode: "object-storage" },
      },
      { requiresAck: true, correlationId: artifact.runId },
    );
    if (messageId) {
      this.manager.setArtifactSync(artifact, "pending", { messageId });
    }
  }

  private async handleArtifactUploadAuthorized(
    message: HibroCoreMessage,
  ): Promise<void> {
    const payload = message.payload as {
      artifactId: string;
      method: "PUT";
      url: string;
      headers?: Record<string, string>;
    };
    if (this.uploadingArtifacts.has(payload.artifactId)) return;
    this.uploadingArtifacts.add(payload.artifactId);
    const artifact = await this.manager.getArtifact(payload.artifactId);
    if (!artifact || !artifact.sha256 || artifact.sizeBytes === undefined) {
      this.uploadingArtifacts.delete(payload.artifactId);
      throw new Error(`artifact is unavailable for upload: ${payload.artifactId}`);
    }
    this.manager.setArtifactSync(artifact, "uploading");
    try {
      const settings = this.manager.getSettings();
      const base = new URL(settings.coreUrl ?? "");
      if (base.protocol === "ws:") base.protocol = "http:";
      if (base.protocol === "wss:") base.protocol = "https:";
      const target = new URL(payload.url, base).toString();
      const body = artifact.localPath
        ? createReadStream(artifact.localPath)
        : Buffer.from(
            artifact.content ?? "",
            artifact.encoding === "base64" ? "base64" : "utf8",
          );
      const response = await fetch(target, {
        method: "PUT",
        headers: payload.headers,
        body: body as unknown as BodyInit,
        ...(artifact.localPath ? { duplex: "half" } : {}),
      } as RequestInit & { duplex?: "half" });
      if (!response.ok) {
        throw new Error(`object upload returned HTTP ${response.status}`);
      }
      const completionMessageId = this.send(
        "artifact.upload.complete",
        {
          artifactId: artifact.id,
          status: "completed",
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
        },
        { requiresAck: true, correlationId: artifact.id },
      );
      this.manager.setArtifactSync(artifact, "uploading", {
        messageId: completionMessageId,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const completionMessageId = this.send(
        "artifact.upload.complete",
        {
          artifactId: artifact.id,
          status: "failed",
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          error: errorMessage,
        },
        { requiresAck: true, correlationId: artifact.id },
      );
      this.manager.setArtifactSync(artifact, "failed", {
        messageId: completionMessageId,
        error: errorMessage,
      });
    } finally {
      this.uploadingArtifacts.delete(payload.artifactId);
    }
  }

  private send(
    type: Parameters<typeof createCoreEnvelope>[0],
    payload: unknown,
    fields: Record<string, unknown> = {},
  ): string | undefined {
    const settings = this.manager.getSettings();
    if (!settings.coreEnabled) return undefined;
    this.sequence += 1;
    const message = createCoreEnvelope(type, payload, {
      nodeId: settings.nodeId,
      sequence: this.sequence,
      ...fields,
    });
    const envelopeJson = JSON.stringify(message);
    if (message.requiresAck) {
      this.manager.store.enqueueCoreMessage({
        messageId: message.messageId,
        type: message.type,
        envelopeJson,
        createdAt: message.sentAt,
        attemptCount: 0,
      });
    }
    if (this.isOpen()) {
      this.socket?.send(envelopeJson);
      if (message.requiresAck) this.deferCoreMessage(message.messageId, 3_000);
    }
    return message.messageId;
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private startTimers(interval: number): void {
    this.stopTimers();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), interval);
    this.heartbeatTimer.unref();
    this.snapshotTimer = setInterval(() => void this.sendSnapshot(), 60_000);
    this.snapshotTimer.unref();
    this.outboxTimer = setInterval(() => this.flushOutbox(), 2_000);
    this.outboxTimer.unref();
    this.flushOutbox();
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.heartbeatTimer = undefined;
    this.snapshotTimer = undefined;
    this.outboxTimer = undefined;
  }

  private flushOutbox(): void {
    if (!this.isOpen()) return;
    for (const record of this.manager.store.pendingCoreMessages(new Date(), 100)) {
      const stored = parseCoreEnvelope(JSON.parse(record.envelopeJson));
      this.sequence += 1;
      this.socket?.send(
        JSON.stringify({
          ...stored,
          sentAt: new Date().toISOString(),
          sequence: this.sequence,
        }),
      );
      const retryDelay = Math.min(30_000, 2_000 * 2 ** Math.min(record.attemptCount, 4));
      this.deferCoreMessage(record.messageId, retryDelay);
    }
  }

  private deferCoreMessage(messageId: string, delayMs: number): void {
    this.manager.store.markCoreMessageAttempt(
      messageId,
      new Date(Date.now() + delayMs),
    );
  }

  private acknowledgeSourceMessage(
    message: HibroCoreMessage,
    failed = false,
  ): void {
    const payload = message.payload as {
      messageId?: string;
      artifact?: {
        artifactId?: string;
        sha256?: string;
        status?: string;
      };
    };
    if (payload.messageId) {
      const sync = this.manager.store.findArtifactSyncByMessage(
        payload.messageId,
      );
      this.manager.store.acknowledgeCoreMessage(payload.messageId);
      const artifactConfirmed =
        sync !== undefined &&
        payload.artifact?.status === "available" &&
        payload.artifact.artifactId === sync.artifactId &&
        payload.artifact.sha256 === sync.sha256;
      if (sync && (failed || artifactConfirmed || sync.status === "uploading")) {
        this.manager.store.upsertArtifactSync({
          ...sync,
          status: failed ? "failed" : "synced",
          messageId: undefined,
          error: failed
            ? String(
                (message.payload as { message?: unknown }).message ??
                  "Core rejected artifact synchronization.",
              )
            : undefined,
          updatedAt: new Date().toISOString(),
        });
      } else if (sync) {
        this.manager.store.upsertArtifactSync({
          ...sync,
          messageId: undefined,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.lastFingerprint = "";
      this.reconcile();
    }, 3_000);
    this.reconnectTimer.unref();
  }
}
