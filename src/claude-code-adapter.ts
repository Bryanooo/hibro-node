import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { EngineType } from "./domain.ts";
import {
  EngineProcessError,
  type AgentEngineAdapter,
  type EngineDoctorResult,
  type EngineExecuteInput,
  type EngineExecutionResult,
} from "./engine-adapter.ts";
import { selectEngineEnvironment } from "./engine-environment.ts";

export interface ClaudeAdapterOptions {
  executable?: string;
  environment?: NodeJS.ProcessEnv | undefined;
}

export interface ClaudeExecuteInput extends EngineExecuteInput {}

export interface ClaudeExecutionResult extends EngineExecutionResult {}

export interface ClaudeDoctorResult extends EngineDoctorResult {
  executable: string;
  version?: string | undefined;
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string | undefined;
  apiProvider?: string | undefined;
  error?: string | undefined;
  credentialSource?: string | undefined;
}

export class ClaudeProcessError extends EngineProcessError {
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(code, message, details);
    this.name = "ClaudeProcessError";
  }
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class ClaudeCodeAdapter implements AgentEngineAdapter {
  readonly engineType: EngineType = "claude-code";
  readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.executable = options.executable ?? process.env.HIBRO_CLAUDE_BIN ?? "claude";
    this.environment = selectEngineEnvironment("claude-code", options.environment);
  }

  async doctor(): Promise<ClaudeDoctorResult> {
    try {
      const versionResult = await this.runCommand(["--version"]);
      if (versionResult.exitCode !== 0) {
        return {
          executable: this.executable,
          installed: false,
          ready: false,
          loggedIn: false,
          error: versionResult.stderr || versionResult.stdout,
        };
      }

      const authResult = await this.runCommand(["auth", "status"]);
      let auth: Record<string, unknown> = {};
      try {
        auth = JSON.parse(authResult.stdout) as Record<string, unknown>;
      } catch {
        auth = {};
      }
      const credentialSource = this.environment.ANTHROPIC_API_KEY
        ? "ANTHROPIC_API_KEY"
        : this.environment.ANTHROPIC_AUTH_TOKEN
          ? "ANTHROPIC_AUTH_TOKEN"
          : undefined;
      const authenticated = auth.loggedIn === true || credentialSource !== undefined;
      return {
        executable: this.executable,
        version: versionResult.stdout.trim(),
        installed: true,
        ready: authenticated,
        loggedIn: authenticated,
        authMethod: typeof auth.authMethod === "string" ? auth.authMethod : undefined,
        apiProvider: typeof auth.apiProvider === "string" ? auth.apiProvider : undefined,
        credentialSource,
        error:
          authenticated
            ? undefined
            : "Claude Code is not logged in; run `claude auth login` or `/login`.",
      };
    } catch (error) {
      return {
        executable: this.executable,
        installed: false,
        ready: false,
        loggedIn: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async execute(input: ClaudeExecuteInput): Promise<ClaudeExecutionResult> {
    await access(input.workspace);
    const approvalHook = input.requestApproval
      ? await this.startApprovalHook(input)
      : undefined;
    const args = this.buildArgs(input, approvalHook?.settings);
    const child = spawn(this.executable, args, {
      cwd: input.workspace,
      env: approvalHook
        ? { ...this.environment, HIBRO_APPROVAL_TOKEN: approvalHook.token }
        : this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let sessionId: string | undefined;
    let finalResult = "";
    let rawResult: Record<string, unknown> | undefined;
    let parseFailure: Error | undefined;
    let timedOut = false;
    const timeoutMs = input.options?.timeoutMs;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    };

    const abortListener = (): void => terminate();
    input.signal?.addEventListener("abort", abortListener, { once: true });
    if (input.signal?.aborted) {
      terminate();
    }

    const timeout =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs)
        : undefined;
    timeout?.unref();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      input.onEvent?.("engine.stderr", { text: chunk });
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        const mapped = this.mapMessage(message);
        if (mapped.sessionId) {
          sessionId = mapped.sessionId;
        }
        if (mapped.result !== undefined) {
          finalResult = mapped.result;
          rawResult = message;
        }
        input.onEvent?.(mapped.type, mapped.payload);
      } catch (error) {
        parseFailure = error instanceof Error ? error : new Error(String(error));
        input.onEvent?.("engine.protocol_error", { line, message: parseFailure.message });
      }
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    }).finally(() => {
      input.signal?.removeEventListener("abort", abortListener);
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      lines.close();
      void approvalHook?.close();
    });

    if (timedOut) {
      throw new ClaudeProcessError("timeout", `Claude Code exceeded ${timeoutMs} ms`, {
        timeoutMs,
      });
    }
    if (input.signal?.aborted) {
      throw new ClaudeProcessError("cancelled", "Claude Code run was cancelled");
    }
    if (parseFailure) {
      throw new ClaudeProcessError("protocol_error", parseFailure.message);
    }

    const resultIsError = rawResult?.is_error === true;
    if (exitCode !== 0 || resultIsError) {
      const resultMessage =
        typeof rawResult?.result === "string" ? rawResult.result : undefined;
      const terminalReason =
        typeof rawResult?.terminal_reason === "string"
          ? rawResult.terminal_reason
          : undefined;
      const code =
        terminalReason === "api_error" && /not logged in/i.test(resultMessage ?? "")
          ? "authentication_failed"
          : "engine_failed";
      throw new ClaudeProcessError(
        code,
        resultMessage || stderr.trim() || `Claude Code exited with code ${exitCode}`,
        { exitCode, terminalReason },
      );
    }

    return { sessionId, result: finalResult, rawResult };
  }

  private buildArgs(
    input: ClaudeExecuteInput,
    approvalSettings?: string,
  ): string[] {
    const options = input.options ?? {};
    const args = [
      "-p",
      input.prompt,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      options.permissionMode ?? "dontAsk",
    ];
    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    args.push("--tools", (options.allowedTools ?? []).join(","));
    if (options.appendSystemPrompt) {
      args.push("--append-system-prompt", options.appendSystemPrompt);
    }
    if (options.maxBudgetUsd !== undefined) {
      args.push("--max-budget-usd", String(options.maxBudgetUsd));
    }
    if (approvalSettings) args.push("--settings", approvalSettings);
    return args;
  }

  private async startApprovalHook(input: ClaudeExecuteInput): Promise<{
    server: Server;
    token: string;
    settings: string;
    close: () => Promise<void>;
  }> {
    const token = randomUUID();
    const server = createServer(async (request, response) => {
      try {
        if (
          request.method !== "POST" ||
          request.headers.authorization !== `Bearer ${token}`
        ) {
          response.writeHead(403).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > 1_048_576) throw new Error("approval request is too large");
          chunks.push(buffer);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        const toolName =
          typeof payload.tool_name === "string" ? payload.tool_name : "Claude tool";
        const toolInput =
          payload.tool_input &&
          typeof payload.tool_input === "object" &&
          !Array.isArray(payload.tool_input)
            ? (payload.tool_input as Record<string, unknown>)
            : {};
        const externalId =
          typeof payload.tool_use_id === "string"
            ? payload.tool_use_id
            : randomUUID();
        const command =
          typeof toolInput.command === "string" ? toolInput.command : undefined;
        const decision = await input.requestApproval!({
          externalId,
          kind:
            toolName === "Bash"
              ? "command"
              : ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(toolName)
                ? "file_change"
                : /Web|Fetch|Search/i.test(toolName)
                  ? "network"
                  : "tool",
          title: `${toolName} 请求审批`,
          detail: command ?? JSON.stringify(toolInput),
          toolName,
          command,
          cwd:
            typeof payload.cwd === "string" ? payload.cwd : input.workspace,
          payload,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: decision === "deny" ? "deny" : "allow",
              permissionDecisionReason:
                decision === "deny"
                  ? "Hibro 操作者拒绝了该操作"
                  : "Hibro 操作者已批准该操作",
            },
          }),
        );
      } catch (error) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to create Claude approval hook");
    }
    const settings = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|Agent",
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${address.port}/approval`,
                timeout: Math.max(
                  60,
                  Math.ceil((input.options?.timeoutMs ?? 600_000) / 1_000),
                ),
                headers: { Authorization: "Bearer $HIBRO_APPROVAL_TOKEN" },
                allowedEnvVars: ["HIBRO_APPROVAL_TOKEN"],
              },
            ],
          },
        ],
      },
    });
    return {
      server,
      token,
      settings,
      close: () =>
        new Promise<void>((resolvePromise) => {
          server.closeAllConnections();
          server.close(() => resolvePromise());
        }),
    };
  }

  private mapMessage(message: Record<string, unknown>): {
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string | undefined;
    result?: string | undefined;
  } {
    const type = typeof message.type === "string" ? message.type : "unknown";
    const subtype = typeof message.subtype === "string" ? message.subtype : undefined;
    const sessionId =
      typeof message.session_id === "string" ? message.session_id : undefined;

    if (type === "system" && subtype === "init") {
      return {
        type: "session.started",
        sessionId,
        payload: {
          sessionId,
          model: message.model,
          tools: message.tools,
          claudeCodeVersion: message.claude_code_version,
        },
      };
    }
    if (type === "system" && subtype === "status") {
      return {
        type: "engine.status",
        sessionId,
        payload: { status: message.status, raw: message },
      };
    }
    if (type === "stream_event") {
      return {
        type: "engine.delta",
        sessionId,
        payload: { event: message.event, parentToolUseId: message.parent_tool_use_id },
      };
    }
    if (type === "assistant") {
      return {
        type: "assistant.message",
        sessionId,
        payload: { message: message.message, error: message.error },
      };
    }
    if (type === "user") {
      return {
        type: "engine.user_message",
        sessionId,
        payload: { message: message.message },
      };
    }
    if (type === "result") {
      const result = typeof message.result === "string" ? message.result : "";
      return {
        type: message.is_error === true ? "engine.failed" : "engine.result",
        sessionId,
        result,
        payload: {
          result,
          isError: message.is_error === true,
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
          usage: message.usage,
          terminalReason: message.terminal_reason,
        },
      };
    }
    return {
      type: "engine.raw",
      sessionId,
      payload: { raw: message },
    };
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
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    return { exitCode, stdout, stderr };
  }
}
