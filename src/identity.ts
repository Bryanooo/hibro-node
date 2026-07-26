import { randomBytes, randomUUID } from "node:crypto";

const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

/**
 * Persistent Hibro IDs use one readable type prefix and a standard UUID.
 * Existing IDs remain valid; this helper only affects newly-created records.
 */
export function createId(prefix: string): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(`invalid id prefix: ${prefix}`);
  }
  return `${prefix}_${randomUUID()}`;
}

export function createSecret(prefix: string, bytes = 32): string {
  if (!PREFIX_PATTERN.test(prefix) || !Number.isInteger(bytes) || bytes < 16) {
    throw new Error("invalid secret parameters");
  }
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}
