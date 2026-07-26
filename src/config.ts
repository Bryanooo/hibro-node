import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export interface NodeConfig {
  host: string;
  port: number;
  dataDir: string;
  claudeExecutable: string;
  codexExecutable: string;
  openclawExecutable: string;
  defaultProjectRoot: string;
  importShellEnvironment: boolean;
  shellExecutable: string;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "7331");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

export function discoverClaudeExecutable(
  homeDir = homedir(),
  pathValue = process.env.PATH ?? "",
): string {
  const configured = process.env.HIBRO_CLAUDE_BIN;
  if (configured) {
    return configured;
  }

  const candidates = pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "claude"));
  candidates.push(
    join(homeDir, ".local", "bin", "claude"),
    join(homeDir, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  );

  const fnmVersions = join(homeDir, ".local", "share", "fnm", "node-versions");
  try {
    const versionDirectories = readdirSync(fnmVersions, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versionDirectories) {
      candidates.push(join(fnmVersions, version, "installation", "bin", "claude"));
    }
  } catch {
    // FNM is optional.
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? "claude";
}

export function loadConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  const importShellEnvironment =
    process.env.HIBRO_IMPORT_SHELL_ENV?.toLowerCase() !== "false";
  return {
    host: overrides.host ?? process.env.HIBRO_NODE_HOST ?? "127.0.0.1",
    port: overrides.port ?? parsePort(process.env.HIBRO_NODE_PORT),
    dataDir:
      overrides.dataDir ??
      process.env.HIBRO_NODE_DATA_DIR ??
      resolve(homedir(), ".hibro-node"),
    claudeExecutable:
      overrides.claudeExecutable ??
      discoverClaudeExecutable(),
    codexExecutable:
      overrides.codexExecutable ??
      process.env.HIBRO_CODEX_BIN ??
      "codex",
    openclawExecutable:
      overrides.openclawExecutable ??
      process.env.HIBRO_OPENCLAW_BIN ??
      "openclaw",
    defaultProjectRoot:
      overrides.defaultProjectRoot ??
      process.env.HIBRO_DEFAULT_PROJECT_ROOT ??
      process.cwd(),
    importShellEnvironment:
      overrides.importShellEnvironment ?? importShellEnvironment,
    shellExecutable:
      overrides.shellExecutable ?? process.env.SHELL ?? "/bin/zsh",
  };
}
