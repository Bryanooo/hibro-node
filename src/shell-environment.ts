import { spawn } from "node:child_process";

export const CLAUDE_SHELL_ENV_KEYS = [
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
] as const;

export interface ShellEnvironmentOptions {
  shellExecutable?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface ShellEnvironmentResult {
  environment: Record<string, string>;
  importedKeys: string[];
  warning?: string | undefined;
}

function parseNullSeparatedEnvironment(output: Buffer): Record<string, string> {
  const allowed = new Set<string>(CLAUDE_SHELL_ENV_KEYS);
  const environment: Record<string, string> = {};
  for (const entry of output.toString("utf8").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const name = entry.slice(0, separator);
    if (!allowed.has(name)) continue;
    environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

export async function loadClaudeShellEnvironment(
  options: ShellEnvironmentOptions = {},
): Promise<ShellEnvironmentResult> {
  const shell = options.shellExecutable ?? process.env.SHELL ?? "/bin/zsh";
  const timeoutMs = options.timeoutMs ?? 5_000;
  const names = CLAUDE_SHELL_ENV_KEYS.join(" ");
  const script = [
    `for name in ${names}; do`,
    '  if (( ${+parameters[$name]} )) && [[ -n "${(P)name}" ]]; then',
    '    printf "%s=%s\\\\0" "$name" "${(P)name}"',
    "  fi",
    "done",
  ].join("\n");

  try {
    const child = spawn(shell, ["-ic", script], {
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let outputSize = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize <= 1_048_576) chunks.push(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => clearTimeout(timer));

    if (exitCode !== 0) {
      return {
        environment: {},
        importedKeys: [],
        warning: `Shell environment command exited with code ${exitCode}`,
      };
    }
    if (outputSize > 1_048_576) {
      return {
        environment: {},
        importedKeys: [],
        warning: "Shell environment output exceeded 1 MiB",
      };
    }

    const environment = parseNullSeparatedEnvironment(Buffer.concat(chunks));
    return {
      environment,
      importedKeys: Object.keys(environment).sort(),
    };
  } catch (error) {
    return {
      environment: {},
      importedKeys: [],
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}

