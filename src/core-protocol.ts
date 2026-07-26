import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AgentRuntime,
  ArtifactRecord,
  CreateRunInput,
  RunEvent,
  RunRecord,
  SystemSettings,
} from "./domain.ts";
import type {
  ConversationDetail,
  ConversationEvent,
} from "./conversation-domain.ts";

export const HIBRO_CORE_PROTOCOL = "hibro.node.v1" as const;

export const CORE_MESSAGE_TYPES = [
  "node.hello",
  "core.welcome",
  "node.snapshot",
  "node.heartbeat",
  "core.heartbeat",
  "message.ack",
  "message.error",
  "agent.upsert",
  "agent.delete",
  "agent.registration",
  "run.create",
  "run.accepted",
  "run.cancel",
  "run.approval.decide",
  "run.snapshot",
  "run.event",
  "artifact.manifest",
  "artifact.upload",
  "artifact.upload.authorized",
  "artifact.upload.complete",
  "settings.patch",
  "conversation.create",
  "conversation.message.create",
  "conversation.cancel",
  "conversation.approval.decide",
  "conversation.snapshot",
  "conversation.event",
] as const;

export type CoreMessageType = (typeof CORE_MESSAGE_TYPES)[number];

export interface CoreEnvelope<TType extends CoreMessageType, TPayload> {
  protocol: typeof HIBRO_CORE_PROTOCOL;
  messageId: string;
  type: TType;
  sentAt: string;
  nodeId?: string | undefined;
  sequence?: number | undefined;
  correlationId?: string | undefined;
  causationId?: string | undefined;
  idempotencyKey?: string | undefined;
  requiresAck?: boolean | undefined;
  trace?: {
    traceId?: string | undefined;
    spanId?: string | undefined;
  };
  payload: TPayload;
}

export interface NodeHelloPayload {
  node: {
    nodeId: string;
    nodeName: string;
    instanceId: string;
    version: string;
    startedAt: string;
    platform: string;
    arch: string;
  };
  authentication: {
    method: "node-token";
    tokenId?: string | undefined;
  };
  protocol: {
    supported: Array<typeof HIBRO_CORE_PROTOCOL>;
    preferred: typeof HIBRO_CORE_PROTOCOL;
  };
  capabilities: {
    engines: Array<{
      id: string;
      version?: string | undefined;
      ready: boolean;
    }>;
    transports: ["websocket"];
    features: string[];
    maxFrameBytes: number;
  };
  resume?: {
    token?: string | undefined;
    lastCoreSequence?: number | undefined;
    lastNodeSequence?: number | undefined;
  };
}

export interface CoreWelcomePayload {
  coreId: string;
  connectionId: string;
  protocol: typeof HIBRO_CORE_PROTOCOL;
  serverTime: string;
  heartbeatIntervalMs: number;
  leaseTtlMs: number;
  maxFrameBytes: number;
  resumeToken: string;
  resumeAccepted: boolean;
  nextCoreSequence: number;
  nextNodeSequence: number;
}

export interface NodeSnapshotPayload {
  generatedAt: string;
  settings: Pick<
    SystemSettings,
    "nodeName" | "maxConcurrentRuns" | "defaultTimeoutMs" | "coreEnabled"
  >;
  agents: AgentRuntime[];
  activeRuns: RunRecord[];
}

export interface HeartbeatPayload {
  observedAt: string;
  activeRuns: number;
  queuedRuns: number;
  agentCount: number;
  freeMemoryBytes?: number | undefined;
  freeDiskBytes?: number | undefined;
  lastReceivedSequence?: number | undefined;
}

export interface MessageAckPayload {
  messageId: string;
  accepted: boolean;
  status: "accepted" | "duplicate" | "rejected";
  persistedAt?: string | undefined;
  error?: ProtocolErrorPayload | undefined;
  artifact?:
    | {
        artifactId: string;
        sha256: string;
        status: "available";
      }
    | undefined;
}

export interface ProtocolErrorPayload {
  code:
    | "authentication_failed"
    | "unsupported_protocol"
    | "invalid_message"
    | "not_found"
    | "conflict"
    | "capacity_exceeded"
    | "engine_unavailable"
    | "permission_denied"
    | "internal_error";
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface AgentUpsertPayload {
  revision: number;
  agent: AgentDefinition;
}

export interface AgentDeletePayload {
  agentId: string;
  revision: number;
}

export interface AgentRegistrationPayload {
  agentId: string;
  status: "registered" | "rejected" | "error";
  coreAgentId?: string | undefined;
  revision?: number | undefined;
  error?: ProtocolErrorPayload | undefined;
}

export interface RunCreatePayload {
  commandId: string;
  requestedBy: {
    userId?: string | undefined;
    teamId?: string | undefined;
    source: "hibro-app" | "hibro-core" | "automation" | "api";
  };
  agentId: string;
  request: CreateRunInput;
  deadlineAt?: string | undefined;
}

export interface RunAcceptedPayload {
  commandId: string;
  runId: string;
  acceptedAt: string;
  queuePosition?: number | undefined;
}

export interface RunCancelPayload {
  commandId: string;
  runId: string;
  reason?: string | undefined;
}

export interface RunSnapshotPayload {
  run: RunRecord;
}

export interface RunEventPayload {
  event: RunEvent;
}

export interface RunApprovalDecisionPayload {
  runId: string;
  externalId: string;
  decision: "allow_once" | "allow_always" | "deny";
}

export interface ArtifactManifestPayload {
  artifact: ArtifactRecord;
  transfer:
    | { mode: "inline"; content: string }
    | { mode: "object-storage" }
    | {
        mode: "upload";
        contentType: string;
        sizeBytes: number;
        sha256: string;
      };
}

export interface ArtifactUploadPayload {
  artifactId: string;
  index: number;
  total: number;
  data: string;
  sha256: string;
  encoding: "utf8" | "base64";
}

export interface ArtifactUploadAuthorizedPayload {
  artifactId: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  provider: "filesystem" | "oss";
}

export interface ArtifactUploadCompletePayload {
  artifactId: string;
  status: "completed" | "failed";
  sizeBytes: number;
  sha256: string;
  error?: string;
}

export interface SettingsPatchPayload {
  revision: number;
  patch: Partial<
    Pick<
      SystemSettings,
      | "defaultTimeoutMs"
      | "maxConcurrentRuns"
      | "allowDangerousSandbox"
      | "autoResumeSessions"
      | "eventRetentionDays"
    >
  >;
}

export interface ConversationCreatePayload {
  conversationId: string;
  agentId: string;
  title?: string | undefined;
  requestedBy: {
    userId?: string | undefined;
    source: "hibro-app" | "hibro-core" | "automation" | "api";
  };
}

export interface ConversationMessageCreatePayload {
  conversationId: string;
  content: string;
  userMessageId: string;
  assistantMessageId: string;
  requestedBy: {
    userId?: string | undefined;
    source: "hibro-app" | "hibro-core" | "automation" | "api";
  };
}

export interface ConversationCancelPayload {
  conversationId: string;
  reason?: string | undefined;
}

export interface ConversationApprovalDecisionPayload {
  conversationId: string;
  activityId: string;
  decision: "allow_once" | "allow_always" | "deny";
}

export interface ConversationSnapshotPayload {
  conversation: ConversationDetail;
}

export interface ConversationEventPayload {
  event: ConversationEvent;
}

export type HibroCoreMessage =
  | CoreEnvelope<"node.hello", NodeHelloPayload>
  | CoreEnvelope<"core.welcome", CoreWelcomePayload>
  | CoreEnvelope<"node.snapshot", NodeSnapshotPayload>
  | CoreEnvelope<"node.heartbeat", HeartbeatPayload>
  | CoreEnvelope<"core.heartbeat", HeartbeatPayload>
  | CoreEnvelope<"message.ack", MessageAckPayload>
  | CoreEnvelope<"message.error", ProtocolErrorPayload>
  | CoreEnvelope<"agent.upsert", AgentUpsertPayload>
  | CoreEnvelope<"agent.delete", AgentDeletePayload>
  | CoreEnvelope<"agent.registration", AgentRegistrationPayload>
  | CoreEnvelope<"run.create", RunCreatePayload>
  | CoreEnvelope<"run.accepted", RunAcceptedPayload>
  | CoreEnvelope<"run.cancel", RunCancelPayload>
  | CoreEnvelope<"run.approval.decide", RunApprovalDecisionPayload>
  | CoreEnvelope<"run.snapshot", RunSnapshotPayload>
  | CoreEnvelope<"run.event", RunEventPayload>
  | CoreEnvelope<"artifact.manifest", ArtifactManifestPayload>
  | CoreEnvelope<"artifact.upload", ArtifactUploadPayload>
  | CoreEnvelope<"artifact.upload.authorized", ArtifactUploadAuthorizedPayload>
  | CoreEnvelope<"artifact.upload.complete", ArtifactUploadCompletePayload>
  | CoreEnvelope<"settings.patch", SettingsPatchPayload>
  | CoreEnvelope<"conversation.create", ConversationCreatePayload>
  | CoreEnvelope<"conversation.message.create", ConversationMessageCreatePayload>
  | CoreEnvelope<"conversation.cancel", ConversationCancelPayload>
  | CoreEnvelope<
      "conversation.approval.decide",
      ConversationApprovalDecisionPayload
    >
  | CoreEnvelope<"conversation.snapshot", ConversationSnapshotPayload>
  | CoreEnvelope<"conversation.event", ConversationEventPayload>;

export function createCoreEnvelope<TType extends CoreMessageType, TPayload>(
  type: TType,
  payload: TPayload,
  fields: Partial<
    Omit<CoreEnvelope<TType, TPayload>, "protocol" | "messageId" | "type" | "sentAt" | "payload">
  > = {},
): CoreEnvelope<TType, TPayload> {
  return {
    protocol: HIBRO_CORE_PROTOCOL,
    messageId: randomUUID(),
    type,
    sentAt: new Date().toISOString(),
    ...fields,
    payload,
  };
}

export function parseCoreEnvelope(value: unknown): HibroCoreMessage {
  if (!value || typeof value !== "object") throw new Error("message must be an object");
  const message = value as Record<string, unknown>;
  if (message.protocol !== HIBRO_CORE_PROTOCOL) {
    throw new Error(`unsupported protocol: ${String(message.protocol)}`);
  }
  if (typeof message.messageId !== "string" || !message.messageId) {
    throw new Error("messageId is required");
  }
  if (
    typeof message.type !== "string" ||
    !CORE_MESSAGE_TYPES.includes(message.type as CoreMessageType)
  ) {
    throw new Error(`unsupported message type: ${String(message.type)}`);
  }
  if (typeof message.sentAt !== "string" || Number.isNaN(Date.parse(message.sentAt))) {
    throw new Error("sentAt must be an ISO timestamp");
  }
  if (!("payload" in message)) throw new Error("payload is required");
  if (
    message.sequence !== undefined &&
    (!Number.isSafeInteger(message.sequence) || Number(message.sequence) < 1)
  ) {
    throw new Error("sequence must be a positive safe integer");
  }
  return message as unknown as HibroCoreMessage;
}
