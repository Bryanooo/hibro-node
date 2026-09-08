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
import { backupDatabase, pruneBackups } from "../scripts/backup-database.ts";
import { AgentPackageManager } from "./agent-package.ts";
import { EngineProviderRegistry } from "./engine-adapter.ts";
import { EngineManager } from "./engine-manager.ts";
import { ENGINE_TYPES, type EngineType } from "./domain.ts";

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
  engineManager: EngineManager;
  importedShellKeys: string[];
  shellWarning?: string | undefined;
}> {
  const layout = await migrateNodeDataLayout(config.dataDir);
  const engineManager = new EngineManager(layout.enginesRoot);
  await engineManager.init();
  const shellEnvironment = config.importShellEnvironment
    ? await loadClaudeShellEnvironment({
        shellExecutable: config.shellExecutable,
      })
    : { environment: {}, importedKeys: [] };
  const agents = new FileAgentRegistry(
    layout.agentsRegistry,
    config.defaultProjectRoot,
  );
  const engineProviders = new EngineProviderRegistry<{
    config: NodeConfig;
    shellEnvironment: Record<string, string>;
  }>();
  engineProviders.register({
    id: "claude-code",
    version: "1",
    capabilities: ["stream-events", "sessions", "approval"],
    create: ({ config: value, shellEnvironment: environment }) => new ClaudeCodeAdapter({
      executable: value.claudeExecutable,
      resolveExecutable: (fallback) => engineManager.resolveExecutable("claude-code", fallback),
      environment,
    }),
  });
  engineProviders.register({
    id: "codex",
    version: "1",
    capabilities: ["stream-events", "sessions", "approval"],
    create: ({ config: value }) => new CodexAdapter({
      executable: value.codexExecutable,
      resolveExecutable: (fallback) => engineManager.resolveExecutable("codex", fallback),
    }),
  });
  engineProviders.register({
    id: "openclaw",
    version: "1",
    capabilities: ["stream-events", "sessions"],
    create: ({ config: value, shellEnvironment: environment }) => new OpenClawAdapter({
      executable: value.openclawExecutable,
      resolveExecutable: (fallback) => engineManager.resolveExecutable("openclaw", fallback),
      environment,
    }),
  });
  return {
    manager: new RunManager({
      dataDir: layout.root,
      store: new SqliteRunStore(layout.root),
      agents,
      workspaces: new WorkspaceManager(layout.agentsRoot),
      packages: new AgentPackageManager(layout.agentPackagesRoot, agents),
      settings: new FileSettingsStore(layout.settings),
      engineManager,
      adapters: engineProviders.createAll({
        config,
        shellEnvironment: shellEnvironment.environment,
      }),
    }),
    engineManager,
    importedShellKeys: shellEnvironment.importedKeys,
    shellWarning: shellEnvironment.warning,
  };
}

function printUsage(): void {
  process.stdout.write(`Hibro Node

Usage:
  npm run doctor -- [--claude-bin PATH] [--codex-bin PATH] [--openclaw-bin PATH]
  node --experimental-strip-types src/cli.ts engine list
  node --experimental-strip-types src/cli.ts engine install|update|activate|enable|disable|uninstall ENGINE [--version X.Y.Z]
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

async function engineCommand(args: string[]): Promise<void> {
  const positional = args.filter((argument, index) =>
    !argument.startsWith("--") && (index === 0 || !args[index - 1]?.startsWith("--")),
  );
  const [action = "list", rawId] = positional;
  const flags = parseFlags(args);
  const config = configFromFlags(flags);
  const layout = await migrateNodeDataLayout(config.dataDir);
  const engines = new EngineManager(layout.enginesRoot);
  await engines.init();
  if (action === "list") {
    process.stdout.write(`${JSON.stringify({ engines: engines.catalog() }, null, 2)}\n`);
    return;
  }
  if (!rawId || !ENGINE_TYPES.includes(rawId as EngineType)) {
    throw new Error(`engine must be one of: ${ENGINE_TYPES.join(", ")}`);
  }
  const id = rawId as EngineType;
  const result = action === "install" || action === "update"
    ? await engines.install(id, value(flags, "version"))
    : action === "activate"
      ? await engines.activate(id, value(flags, "version") ?? "")
    : action === "enable"
      ? await engines.setEnabled(id, true)
      : action === "disable"
        ? await engines.setEnabled(id, false)
        : action === "uninstall"
          ? await engines.uninstall(id)
          : undefined;
  if (!result) throw new Error(`unsupported engine action: ${action}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  await runtime.manager.shutdown(0);
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
    await manager.shutdown();
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
    engineManager: runtime.engineManager,
    onEngineCapabilitiesChanged: () => coreTransport.refreshCapabilities(),
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

  const createBackup = async (): Promise<string> => {
    const directory = join(config.dataDir, "backups");
    const result = await backupDatabase(
      manager.store.databasePath ?? join(config.dataDir, "hibro.db"),
      join(directory, `hibro-node-${new Date().toISOString().replaceAll(":", "-")}.db`),
    );
    await pruneBackups(directory, "hibro-node-");
    return result;
  };
  await createBackup().catch((error) => {
    process.stderr.write(`${JSON.stringify({ type: "database.backup.error", message: String(error) })}\n`);
    return "";
  });
  const backupTimer = setInterval(
    () => void createBackup().catch((error) => {
      process.stderr.write(`${JSON.stringify({ type: "database.backup.error", message: String(error) })}\n`);
    }),
    24 * 60 * 60 * 1_000,
  );
  backupTimer.unref();

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(backupTimer);
    coreTransport.stop();
    const httpClosed = new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    });
    void httpClosed
      .then(() => conversations.close())
        .then(() => manager.shutdown())
        .then(() => process.exit(0))
        .catch((error) => {
          process.stderr.write(`${JSON.stringify({ type: "node.shutdown.error", message: String(error) })}\n`);
          process.exit(1);
        });
    setTimeout(() => {
      server.closeAllConnections();
    }, 10_000).unref();
    setTimeout(() => {
      process.stderr.write(`${JSON.stringify({ type: "node.shutdown.timeout" })}\n`);
      process.exit(1);
    }, 30_000).unref();
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
  if (command === "engine") return engineCommand(args);
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
