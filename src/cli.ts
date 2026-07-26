#!/usr/bin/env node
import { resolve } from "node:path";
import { loadConfig, type NodeConfig } from "./config.ts";
import { ClaudeCodeAdapter } from "./claude-code-adapter.ts";
import { CodexAdapter } from "./codex-adapter.ts";
import { OpenClawAdapter } from "./openclaw-adapter.ts";
import { FileAgentRegistry } from "./agent-registry.ts";
import { SqliteRunStore } from "./storage.ts";
import { RunManager } from "./run-manager.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { FileSettingsStore } from "./settings-store.ts";
import { createHibroHttpServer, listen } from "./http-server.ts";
import { loadClaudeShellEnvironment } from "./shell-environment.ts";
import { join } from "node:path";
import { CoreTransport } from "./core-transport.ts";
import { ConversationStore } from "./conversation-store.ts";
import { ConversationService } from "./conversation-service.ts";
import { migrateNodeDataLayout } from "./data-layout.ts";

type Flags = Record<string, string | boolean>;

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function value(flags: Flags, key: string): string | undefined {
  const result = flags[key];
  return typeof result === "string" ? result : undefined;
}

function configFromFlags(flags: Flags): NodeConfig {
  const portValue = value(flags, "port");
  const overrides: Partial<NodeConfig> = {};
  const host = value(flags, "host");
  const dataDir = value(flags, "data-dir");
  const claudeExecutable = value(flags, "claude-bin");
  const codexExecutable = value(flags, "codex-bin");
  const openclawExecutable = value(flags, "openclaw-bin");
  const defaultProjectRoot = value(flags, "project-root");
  const shellExecutable = value(flags, "shell");
  if (host) overrides.host = host;
  if (portValue) overrides.port = Number(portValue);
  if (dataDir) overrides.dataDir = dataDir;
  if (claudeExecutable) overrides.claudeExecutable = claudeExecutable;
  if (codexExecutable) overrides.codexExecutable = codexExecutable;
  if (openclawExecutable) overrides.openclawExecutable = openclawExecutable;
  if (defaultProjectRoot) overrides.defaultProjectRoot = defaultProjectRoot;
  if (shellExecutable) overrides.shellExecutable = shellExecutable;
  if (flags["no-shell-env"] === true) overrides.importShellEnvironment = false;
  return loadConfig(overrides);
}

async function buildManager(config: NodeConfig): Promise<{
  manager: RunManager;
  importedShellKeys: string[];
  shellWarning?: string | undefined;
}> {
  const layout = await migrateNodeDataLayout(config.dataDir);
  const shellEnvironment = config.importShellEnvironment
    ? await loadClaudeShellEnvironment({
        shellExecutable: config.shellExecutable,
      })
    : { environment: {}, importedKeys: [] };
  return {
    manager: new RunManager({
      dataDir: layout.root,
      store: new SqliteRunStore(layout.root),
      agents: new FileAgentRegistry(
        layout.agentsRegistry,
        config.defaultProjectRoot,
      ),
      workspaces: new WorkspaceManager(layout.agentsRoot),
      settings: new FileSettingsStore(layout.settings),
      adapters: [
        new ClaudeCodeAdapter({
          executable: config.claudeExecutable,
          environment: shellEnvironment.environment,
        }),
        new CodexAdapter({ executable: config.codexExecutable }),
        new OpenClawAdapter({
          executable: config.openclawExecutable,
          environment: shellEnvironment.environment,
        }),
      ],
    }),
    importedShellKeys: shellEnvironment.importedKeys,
    shellWarning: shellEnvironment.warning,
  };
}

function printUsage(): void {
  process.stdout.write(`Hibro Node

Usage:
  npm run doctor -- [--claude-bin PATH] [--codex-bin PATH] [--openclaw-bin PATH]
  npm run run -- --prompt TEXT [--agent ID] [--session-id UUID]
  npm start -- [--host 127.0.0.1] [--port 7331]

Environment:
  HIBRO_CLAUDE_BIN       Claude Code executable
  HIBRO_CODEX_BIN        Codex executable
  HIBRO_OPENCLAW_BIN     OpenClaw executable
  HIBRO_NODE_DATA_DIR    Persistent Hibro Home directory
  HIBRO_NODE_HOST        HTTP bind host
  HIBRO_NODE_PORT        HTTP bind port
  HIBRO_IMPORT_SHELL_ENV Import Claude variables from interactive shell (default: true)
`);
}

async function doctor(flags: Flags): Promise<void> {
  const config = configFromFlags(flags);
  const runtime = await buildManager(config);
  await runtime.manager.init();
  const result = await runtime.manager.doctorEngines();
  process.stdout.write(
    `${JSON.stringify(
      {
        engines: result,
        importedShellKeys: runtime.importedShellKeys,
        shellWarning: runtime.shellWarning,
      },
      null,
      2,
    )}\n`,
  );
  if (!result.some((engine) => engine.doctor.ready)) {
    process.exitCode = 1;
  }
}

async function runOnce(flags: Flags): Promise<void> {
  const prompt = value(flags, "prompt");
  if (!prompt) {
    throw new Error("--prompt is required");
  }
  const config = configFromFlags(flags);
  const runtime = await buildManager(config);
  const { manager } = runtime;
  await manager.init();
  const unsubscribe = manager.subscribeAll((event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  });
  try {
    const timeout = value(flags, "timeout-ms");
    const run = await manager.create({
      prompt,
      agentId: value(flags, "agent"),
      workspace: resolve(value(flags, "workspace") ?? process.cwd()),
      options: {
        sessionId: value(flags, "session-id"),
        model: value(flags, "model"),
        timeoutMs: timeout ? Number(timeout) : undefined,
        permissionMode: "dontAsk",
      },
    });
    const terminal = await manager.waitForTerminal(run.id);
    process.stdout.write(`${JSON.stringify({ type: "run.summary", run: terminal })}\n`);
    if (terminal.status !== "completed") {
      process.exitCode = 1;
    }
  } finally {
    unsubscribe();
  }
}

async function serve(flags: Flags): Promise<void> {
  const config = configFromFlags(flags);
  const runtime = await buildManager(config);
  const { manager } = runtime;
  await manager.init();
  const conversations = new ConversationService(
    new ConversationStore(
      manager.store.databasePath ?? join(config.dataDir, "hibro.db"),
    ),
    manager,
  );
  await conversations.init();
  const coreTransport = new CoreTransport(manager, conversations);
  coreTransport.start();
  const server = createHibroHttpServer({
    host: config.host,
    port: config.port,
    manager,
    conversations,
  });
  const address = await listen(server, config.host, config.port);
  process.stdout.write(
    `${JSON.stringify({
      type: "node.started",
      address: `http://${address.address}:${address.port}`,
      dataDir: config.dataDir,
      claudeExecutable: config.claudeExecutable,
      importedShellKeys: runtime.importedShellKeys,
      shellWarning: runtime.shellWarning,
    })}\n`,
  );

  const shutdown = (): void => {
    coreTransport.stop();
    server.close(() => {
      void conversations.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  const flags = parseFlags(args);
  if (command === "doctor") return doctor(flags);
  if (command === "run") return runOnce(flags);
  if (command === "serve") return serve(flags);
  printUsage();
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      type: "node.error",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
});
