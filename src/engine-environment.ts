import type { EngineType } from "./domain.ts";

const COMMON_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HIBRO_CONTAINER",
] as const;

const ENGINE_KEYS: Record<EngineType, readonly string[]> = {
  "claude-code": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ],
  codex: [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "AZURE_OPENAI_API_KEY",
    "CODEX_HOME",
  ],
  openclaw: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "HIBRO_OPENCLAW_MODEL",
  ],
};

export function selectEngineEnvironment(
  engine: EngineType,
  override: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const source = { ...process.env, ...override };
  const result: NodeJS.ProcessEnv = {};
  for (const key of [...COMMON_KEYS, ...ENGINE_KEYS[engine]]) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

