import { access, copyFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  EngineProcessError,
  type AgentEngineAdapter,
  type EngineDoctorResult,
  type EngineExecuteInput,
  type EngineExecutionResult,
} from "./engine-adapter.ts";
import { selectEngineEnvironment } from "./engine-environment.ts";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RpcMessage extends Record<string, unknown> {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexAdapterOptions {
  executable?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

export class CodexAdapter implements AgentEngineAdapter {
  readonly engineType = "codex" as const;
  readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: CodexAdapterOptions = {}) {
    this.executable = options.executable ?? process.env.HIBRO_CODEX_BIN ?? "codex";
    this.environment = selectEngineEnvironment("codex", options.environment);
  }

  async doctor(): Promise<EngineDoctorResult> {
    try {
      const version = await this.runCommand(["--version"]);
      if (version.exitCode !== 0) {
        return {
          executable: this.executable,
          installed: false,
          ready: false,
          error: version.stderr || version.stdout,
        };
      }
      const login = await this.runCommand(["login", "status"]);
      const ready = login.exitCode === 0;
      return {
        executable: this.executable,
        version: version.stdout.trim(),
        installed: true,
        ready,
        loggedIn: ready,
        authMethod: login.stdout.trim() || undefined,
        error: ready ? undefined : login.stderr.trim() || login.stdout.trim(),
      };
    } catch (error) {
      return {
        executable: this.executable,
        installed: false,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(input: EngineExecuteInput): Promise<EngineExecutionResult> {
    await access(input.workspace);
    const environment = await this.prepareEnvironment(input);
    const args = ["app-server", "--stdio"];
    if (
      process.platform === "linux" &&
      this.environment.HIBRO_CONTAINER === "docker"
    ) {
      args.push("-c", "use_legacy_landlock=true");
    }
    const child = spawn(this.executable, args, {
      cwd: input.workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const processExit = new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
    let stderr = "";
    let sessionId: string | undefined;
    let result = "";
    let rawResult: Record<string, unknown> | undefined;
    let parseFailure: Error | undefined;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let timeoutStartedAt = 0;
    let remainingTimeoutMs = input.options?.timeoutMs;
    let requestId = 0;
    let completed = false;
    const pending = new Map<
      number,
      {
        resolve: (value: Record<string, unknown>) => void;
        reject: (reason: Error) => void;
      }
    >();
    void processExit.then((code) => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`Codex app-server exited with code ${code}`));
      }
      pending.clear();
    });
    let resolveTurn!: () => void;
    let rejectTurn!: (reason: Error) => void;
    const turnCompleted = new Promise<void>((resolvePromise, reject) => {
      resolveTurn = resolvePromise;
      rejectTurn = reject;
    });

    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    };
    const abortListener = (): void => terminate();
    input.signal?.addEventListener("abort", abortListener, { once: true });
    if (input.signal?.aborted) terminate();
    const timeoutMs = input.options?.timeoutMs;
    const resumeTimeout = (): void => {
      if (
        remainingTimeoutMs === undefined ||
        timeout ||
        timedOut ||
        completed
      ) {
        return;
      }
      timeoutStartedAt = Date.now();
      timeout = setTimeout(() => {
        timeout = undefined;
        remainingTimeoutMs = 0;
        timedOut = true;
        terminate();
      }, Math.max(0, remainingTimeoutMs));
      timeout.unref();
    };
    const pauseTimeout = (): void => {
      if (!timeout || remainingTimeoutMs === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
      remainingTimeoutMs = Math.max(
        0,
        remainingTimeoutMs - (Date.now() - timeoutStartedAt),
      );
    };
    resumeTimeout();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      input.onEvent?.("engine.stderr", { text: chunk });
    });
    const write = (message: RpcMessage): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      requestId += 1;
      const id = requestId;
      return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject });
        write({ id, method, params });
      });
    };
    const respondToApproval = async (message: RpcMessage): Promise<void> => {
      const method = message.method ?? "";
      const params = message.params ?? {};
      if (!input.requestApproval || message.id === undefined) {
        write({ id: message.id!, result: { decision: "decline" } });
        return;
      }
      const externalId = String(
        params.approvalId ?? params.itemId ?? message.id,
      );
      const command =
        typeof params.command === "string" ? params.command : undefined;
      pauseTimeout();
      let decision;
      try {
        decision = await input.requestApproval({
          externalId,
          kind: method.includes("fileChange")
            ? "file_change"
            : method.includes("permissions")
              ? "permission"
              : params.networkApprovalContext
                ? "network"
                : "command",
          title: method.includes("fileChange")
            ? "Codex 请求修改文件"
            : method.includes("permissions")
              ? "Codex 请求扩展权限"
              : "Codex 请求执行命令",
          detail:
            command ??
            (typeof params.reason === "string"
              ? params.reason
              : JSON.stringify(params)),
          command,
          cwd: typeof params.cwd === "string" ? params.cwd : input.workspace,
          toolName: method,
          payload: params,
        });
      } finally {
        resumeTimeout();
      }
      if (method === "item/permissions/requestApproval") {
        write({
          id: message.id,
          result:
            decision === "deny"
              ? { permissions: {}, scope: "turn" }
              : {
                  permissions: params.permissions ?? {},
                  scope: decision === "allow_always" ? "session" : "turn",
                },
        });
      } else {
        write({
          id: message.id,
          result: {
            decision:
              decision === "deny"
                ? "decline"
                : decision === "allow_always"
                  ? "acceptForSession"
                  : "accept",
          },
        });
      }
    };
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (message.id !== undefined && !message.method) {
          const id = Number(message.id);
          const waiter = pending.get(id);
          if (waiter) {
            pending.delete(id);
            if (message.error) {
              waiter.reject(
                new Error(message.error.message ?? `Codex RPC ${id} failed`),
              );
            } else {
              waiter.resolve(message.result ?? {});
            }
          }
          return;
        }
        if (message.id !== undefined && message.method) {
          if (
            [
              "item/commandExecution/requestApproval",
              "item/fileChange/requestApproval",
              "item/permissions/requestApproval",
            ].includes(message.method)
          ) {
            void respondToApproval(message).catch((error) => {
              write({
                id: message.id!,
                result: { decision: "decline" },
              });
              input.onEvent?.("engine.approval_error", {
                message: error instanceof Error ? error.message : String(error),
              });
            });
          } else {
            write({
              id: message.id,
              error: { code: -32601, message: `Unsupported request: ${message.method}` },
            });
          }
          return;
        }
        const method = message.method ?? "raw";
        const params = message.params ?? {};
        if (
          method === "item/agentMessage/delta" &&
          typeof params.delta === "string"
        ) {
          result += params.delta;
          input.onEvent?.("assistant.message", {
            message: params.delta,
            delta: true,
          });
        }
        const item = params.item as Record<string, unknown> | undefined;
        if (
          method === "item/completed" &&
          item?.type === "agentMessage" &&
          typeof item.text === "string"
        ) {
          result = item.text;
          rawResult = item;
          input.onEvent?.("assistant.message", { message: item.text, item });
        }
        if (method === "turn/completed") {
          completed = true;
          rawResult = params;
          const turn = params.turn as Record<string, unknown> | undefined;
          if (turn?.status === "failed") {
            rejectTurn(
              new Error(
                typeof (turn.error as Record<string, unknown> | undefined)?.message ===
                  "string"
                  ? String((turn.error as Record<string, unknown>).message)
                  : "Codex turn failed",
              ),
            );
          } else {
            resolveTurn();
          }
        }
        input.onEvent?.(`engine.${method.replaceAll("/", ".")}`, {
          raw: message,
          ...params,
        });
        if (method === "error") {
          rejectTurn(new Error(String(params.message ?? "Codex app-server error")));
          return;
        }
      } catch (error) {
        parseFailure = error instanceof Error ? error : new Error(String(error));
        input.onEvent?.("engine.protocol_error", { line, message: parseFailure.message });
        rejectTurn(parseFailure);
      }
    });

    let executionError: unknown;
    try {
      await request("initialize", {
        clientInfo: {
          name: "hibro_node",
          title: "Hibro Node",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      write({ method: "initialized", params: {} });
      const sandbox = input.options?.sandbox ?? "read-only";
      const threadResult = input.options?.sessionId
        ? await request("thread/resume", {
            threadId: input.options.sessionId,
            cwd: input.workspace,
            approvalPolicy: "on-request",
            sandbox,
          })
        : await request("thread/start", {
            cwd: input.workspace,
            approvalPolicy: "on-request",
            sandbox,
            ...(input.options?.model ? { model: input.options.model } : {}),
            ...(input.options?.appendSystemPrompt
              ? { developerInstructions: input.options.appendSystemPrompt }
              : {}),
          });
      const thread = threadResult.thread as Record<string, unknown> | undefined;
      sessionId =
        typeof thread?.id === "string" ? thread.id : input.options?.sessionId;
      if (!sessionId) throw new Error("Codex app-server returned no thread id");
      input.onEvent?.("session.started", { sessionId });
      await request("turn/start", {
        threadId: sessionId,
        input: [{ type: "text", text: input.prompt, text_elements: [] }],
        cwd: input.workspace,
        approvalPolicy: "on-request",
        sandboxPolicy: this.sandboxPolicy(sandbox, input.workspace),
        ...(input.options?.model ? { model: input.options.model } : {}),
      });
      await Promise.race([
        turnCompleted,
        processExit.then((code) => {
          if (!completed && !timedOut && !input.signal?.aborted) {
            throw new Error(`Codex app-server exited with code ${code}`);
          }
        }),
      ]);
    } catch (error) {
      executionError = error;
    } finally {
      terminate();
      await processExit.catch(() => 1);
      input.signal?.removeEventListener("abort", abortListener);
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      lines.close();
      for (const waiter of pending.values()) {
        waiter.reject(new Error("Codex app-server stopped"));
      }
      pending.clear();
    }
    if (timedOut) throw new EngineProcessError("timeout", `Codex exceeded ${timeoutMs} ms`);
    if (input.signal?.aborted) throw new EngineProcessError("cancelled", "Codex run was cancelled");
    if (executionError) throw executionError;
    if (parseFailure) throw new EngineProcessError("protocol_error", parseFailure.message);
    if (!completed) throw new EngineProcessError("engine_failed", stderr.trim() || "Codex stopped");
    return { sessionId, result, rawResult };
  }

  private sandboxPolicy(
    sandbox: "read-only" | "workspace-write" | "danger-full-access",
    workspace: string,
  ): Record<string, unknown> {
    if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
    if (sandbox === "workspace-write") {
      return {
        type: "workspaceWrite",
        writableRoots: [workspace],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    return { type: "readOnly", networkAccess: false };
  }

  private async runCommand(args: string[]): Promise<CommandResult> {
    const child = spawn(this.executable, args, {
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
    return { exitCode, stdout, stderr };
  }

  private async prepareEnvironment(
    input: EngineExecuteInput,
  ): Promise<NodeJS.ProcessEnv> {
    if (!input.statePath) return this.environment;
    const target = join(input.statePath, "codex");
    await mkdir(target, { recursive: true });
    const source = this.environment.CODEX_HOME;
    if (source && source !== target) {
      for (const filename of ["auth.json", "config.toml"]) {
        const destination = join(target, filename);
        try {
          await access(destination);
        } catch {
          try {
            await copyFile(join(source, filename), destination);
          } catch {
            // Auth may be provided through another supported Codex mechanism.
          }
        }
      }
    }
    return { ...this.environment, CODEX_HOME: target };
  }
}
