export type ConversationStatus =
  | "idle"
  | "responding"
  | "error"
  | "archived";

export type ConversationSource = "node" | "core";

export interface Conversation {
  id: string;
  title: string;
  agentId: string;
  engine: "claude-code" | "codex" | "openclaw";
  status: ConversationStatus;
  source: ConversationSource;
  createdBy: string;
  engineSessionId?: string | undefined;
  activeRunId?: string | undefined;
  lastMessageAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type ConversationMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  content: string;
  status: "queued" | "streaming" | "completed" | "failed";
  runId?: string | undefined;
  error?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type ConversationActivityType =
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "progress"
  | "error";

export interface ConversationApproval {
  provider: "claude-code" | "codex" | "openclaw" | "hibro";
  externalId?: string | undefined;
  decisions: Array<"allow_once" | "allow_always" | "deny">;
  decision?: "allow_once" | "allow_always" | "deny" | undefined;
  resolvable: boolean;
  expiresAt?: string | undefined;
  reason?: string | undefined;
}

export interface ConversationActivity {
  id: string;
  conversationId: string;
  messageId?: string | undefined;
  runId?: string | undefined;
  type: ConversationActivityType;
  status: "pending" | "running" | "completed" | "failed" | "denied";
  title: string;
  detail?: string | undefined;
  payload?: Record<string, unknown> | undefined;
  approval?: ConversationApproval | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationEvent {
  conversationId: string;
  sequence: number;
  type:
    | "conversation.created"
    | "conversation.updated"
    | "message.created"
    | "message.updated"
    | "activity.created"
    | "activity.updated";
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ConversationMessage[];
  activities: ConversationActivity[];
}
