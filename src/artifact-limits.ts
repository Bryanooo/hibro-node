export const DEFAULT_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024;

/** Keep malformed configuration from silently disabling Artifact discovery. */
export function nodeArtifactMaxBytes(
  value = process.env.HIBRO_NODE_ARTIFACT_MAX_BYTES,
): number {
  if (!value?.trim()) return DEFAULT_ARTIFACT_MAX_BYTES;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ARTIFACT_MAX_BYTES;
}
