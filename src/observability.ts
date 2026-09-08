import { createHash } from "node:crypto";
import type {
  ObservabilityEventCategory,
  ObservabilitySeverity,
  TraceContext,
} from "./domain.ts";
import { createId } from "./identity.ts";

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;
const TRACE_ID = /^[a-z][a-z0-9]{1,15}_[a-zA-Z0-9_-]{8,}$/;

export function traceContextFromMetadata(
  metadata: Record<string, unknown> | undefined,
): TraceContext {
  const raw = metadata?.trace;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    if (
      typeof value.traceId === "string" &&
      typeof value.rootSpanId === "string" &&
      TRACE_ID.test(value.traceId) &&
      TRACE_ID.test(value.rootSpanId)
    ) {
      return {
        traceId: value.traceId,
        rootSpanId: value.rootSpanId,
        ...(typeof value.parentSpanId === "string" && TRACE_ID.test(value.parentSpanId)
          ? { parentSpanId: value.parentSpanId }
          : {}),
      };
    }
  }
  return { traceId: createId("trace"), rootSpanId: createId("span") };
}

export function fallbackTraceContext(runId: string): TraceContext {
  const digest = createHash("sha256").update(runId).digest("hex");
  return {
    traceId: `trace_${digest.slice(0, 32)}`,
    rootSpanId: `span_${digest.slice(32)}`,
  };
}

export function eventCategory(type: string): ObservabilityEventCategory {
  const normalized = type.toLowerCase();
  if (normalized.includes("approval")) return "approval";
  if (normalized.includes("artifact")) return "artifact";
  if (normalized.includes("tool") || normalized.includes("command") || normalized.includes("file_change")) return "tool";
  if (normalized.includes("stderr") || normalized.includes("protocol_error") || normalized.includes("log")) return "log";
  if (normalized.startsWith("run.") || normalized.includes("session")) return "lifecycle";
  if (normalized.startsWith("engine.")) return "model";
  return "system";
}

export function eventSeverity(type: string): ObservabilitySeverity {
  const normalized = type.toLowerCase();
  if (normalized.includes("failed") || normalized.includes("error") || normalized.includes("stderr")) return "error";
  if (normalized.includes("warning") || normalized.includes("denied") || normalized.includes("timeout")) return "warning";
  if (normalized.includes("delta") || normalized.includes("raw")) return "debug";
  return "info";
}

export function sanitizeObservabilityPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(payload, 0) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (depth >= 7) return "[truncated]";
  if (typeof value === "string") {
    return redactInlineSecrets(value).slice(0, 32_000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) {
      result[childKey] = sanitizeValue(childValue, depth + 1, childKey);
    }
    return result;
  }
  return value;
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    );
}
