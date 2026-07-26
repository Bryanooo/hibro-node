import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  EngineProcessError,
  type AgentEngineAdapter,
  type EngineDoctorResult,
  type EngineExecuteInput,
  type EngineExecutionResult,
} from "./engine-adapter.ts";
import { writeJsonAtomically } from "./storage.ts";
import { selectEngineEnvironment } from "./engine-environment.ts";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface OpenClawPayload {
  text?: string | undefined;
  mediaUrl?: string | null | undefined;
}

interface OpenClawJsonResult extends Record<string, unknown> {
  payloads?: OpenClawPayload[] | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  result?: Record<string, unknown> | undefined;
}

export interface OpenClawAdapterOptions {
  executable?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  defaultModel?: string | undefined;
}

export class OpenClawAdapter implements AgentEngineAdapter {
  readonly engineType = "openclaw" as const;
  readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly defaultModel: string;

  constructor(options: OpenClawAdapterOptions = {}) {
    this.executable = options.executable ?? process.env.HIBRO_OPENCLAW_BIN ?? "openclaw";
    this.environment = selectEngineEnvironment("openclaw", options.environment);
    const providerModel =
      this.environment.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
    this.defaultModel =
      options.defaultModel ??
      this.environment.HIBRO_OPENCLAW_MODEL ??
      (this.environment.ANTHROPIC_BASE_URL
        ? `hibro-anthropic/${providerModel}`
        : `anthropic/${providerModel}`);
  }

  async doctor(): Promise<EngineDoctorResult> {
    try {
      const version = await this.runCommand(["--version"]);
      if (version.exitCode !== 0) {
        return {
          executable: this.executable,
          installed: false,
          ready: false,
          error: version.stderr.trim() || version.stdout.trim(),
        };
      }
      const credentialSource = this.credentialSource();
      return {
        executable: this.executable,
        version: version.stdout.trim(),
        installed: true,
        ready: credentialSource !== undefined,
        loggedIn: credentialSource !== undefined,
        authMethod: credentialSource ? "anthropic-token" : undefined,
        credentialSource,
        model: this.defaultModel,
        error: credentialSource
          ? undefined
          : "OpenClaw 需要 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN",
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
    if (!input.statePath) {
      throw new EngineProcessError(
        "invalid_runtime",
        "OpenClaw requires an Agent-private state directory",
      );
    }
    const runId = input.runId ?? randomUUID();
    const requestsHostExecution =
      input.options?.sandbox === "danger-full-access" ||
      (input.options?.allowedTools ?? []).some((tool) =>
        /^(exec|process|code_execution)$/i.test(tool),
      );
    let hostExecutionApproved = false;
    if (requestsHostExecution) {
      if (!input.requestApproval) {
        throw new EngineProcessError(
          "approval_unavailable",
          "OpenClaw host execution requires a Hibro approval provider",
        );
      }
      const decision = await input.requestApproval({
        externalId: `openclaw-host-exec-${runId}`,
        kind: "permission",
        title: "OpenClaw 请求启用主机命令执行",
        detail:
          "本次运行将允许 OpenClaw 在 Agent 隔离工作空间内调用 exec/process 工具。",
        toolName: "openclaw.exec",
        cwd: input.workspace,
        payload: {
          sandbox: input.options?.sandbox,
          allowedTools: input.options?.allowedTools,
        },
      });
      if (decision === "deny") {
        throw new EngineProcessError(
          "approval_denied",
          "OpenClaw host execution was denied",
        );
      }
      hostExecutionApproved = true;
    }
    const openClawState = join(input.statePath, "openclaw");
    const configDir = join(openClawState, "hibro-config");
    const configPath = join(configDir, `${runId}.json`);
    await mkdir(configDir, { recursive: true });
    await writeJsonAtomically(
      configPath,
      this.buildConfig(input, hostExecutionApproved),
    );

    const environment = this.buildEnvironment(input, openClawState, configPath);
    const args = this.buildArgs(input);
    const child = spawn(this.executable, args, {
      cwd: input.workspace,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

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
    const timeout =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs)
        : undefined;
    timeout?.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      input.onEvent?.("engine.stderr", { text: chunk });
    });

    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolvePromise(code ?? 1));
    }).finally(() => {
      input.signal?.removeEventListener("abort", abortListener);
      if (timeout) clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    });

    if (timedOut) {
      throw new EngineProcessError("timeout", `OpenClaw exceeded ${timeoutMs} ms`, {
        timeoutMs,
      });
    }
    if (input.signal?.aborted) {
      throw new EngineProcessError("cancelled", "OpenClaw run was cancelled");
    }
    if (exitCode !== 0) {
      throw new EngineProcessError(
        "engine_failed",
        stderr.trim() || stdout.trim() || `OpenClaw exited with code ${exitCode}`,
        { exitCode },
      );
    }

    let rawResult: OpenClawJsonResult;
    try {
      rawResult = JSON.parse(stdout) as OpenClawJsonResult;
    } catch (error) {
      throw new EngineProcessError(
        "protocol_error",
        `OpenClaw returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { stdout: stdout.slice(0, 2_000) },
      );
    }
    const result = this.extractText(rawResult);
    if (!result) {
      throw new EngineProcessError("protocol_error", "OpenClaw returned no text payload", {
        rawResult,
      });
    }
    const sessionId = this.extractSession(rawResult) ?? input.sessionKey;
    if (sessionId) input.onEvent?.("session.started", { sessionId });
    input.onEvent?.("assistant.message", { message: result, payloads: rawResult.payloads });
    return { sessionId, result, rawResult };
  }

  private buildArgs(input: EngineExecuteInput): string[] {
    const timeoutSeconds = Math.max(
      1,
      Math.ceil((input.options?.timeoutMs ?? 600_000) / 1_000),
    );
    const message = input.options?.appendSystemPrompt
      ? `[Hibro Agent Instructions]\n${input.options.appendSystemPrompt}\n\n[Task]\n${input.prompt}`
      : input.prompt;
    return [
      "agent",
      "--local",
      "--agent",
      "main",
      "--session-key",
      input.sessionKey ?? `hibro-${input.runId ?? "default"}`,
      "--message",
      message,
      "--timeout",
      String(timeoutSeconds),
      "--json",
    ];
  }

  private buildConfig(
    input: EngineExecuteInput,
    hostExecutionApproved: boolean,
  ): Record<string, unknown> {
    const readOnly = input.options?.sandbox === "read-only";
    const primaryModel = input.options?.model ?? this.defaultModel;
    const config: Record<string, unknown> = {
      wizard: { securityAcknowledgedAt: new Date().toISOString() },
      gateway: { mode: "local" },
      agents: {
        defaults: {
          workspace: input.workspace,
          skipBootstrap: true,
          contextInjection: "always",
          model: { primary: primaryModel },
          timeoutSeconds: Math.max(
            1,
            Math.ceil((input.options?.timeoutMs ?? 600_000) / 1_000),
          ),
        },
      },
      tools: {
        profile: "coding",
        fs: { workspaceOnly: true },
        exec: {
          mode: hostExecutionApproved ? "full" : "deny",
          applyPatch: { workspaceOnly: true },
        },
        deny: readOnly
          ? ["group:runtime", "write", "edit", "apply_patch"]
          : hostExecutionApproved
            ? []
            : ["exec", "process", "code_execution"],
      },
    };
    if (this.environment.ANTHROPIC_BASE_URL) {
      const modelId =
        primaryModel.startsWith("hibro-anthropic/")
          ? primaryModel.slice("hibro-anthropic/".length)
          : this.environment.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
      config.models = {
        mode: "merge",
        providers: {
          "hibro-anthropic": {
            baseUrl: this.environment.ANTHROPIC_BASE_URL,
            apiKey: "${ANTHROPIC_API_KEY}",
            api: "anthropic-messages",
            models: [
              {
                id: modelId,
                name: modelId,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                contextTokens: 96_000,
                maxTokens: 16_384,
              },
            ],
          },
        },
      };
    }
    return config;
  }

  private buildEnvironment(
    input: EngineExecuteInput,
    stateDir: string,
    configPath: string,
  ): NodeJS.ProcessEnv {
    const apiKey =
      this.environment.ANTHROPIC_API_KEY ?? this.environment.ANTHROPIC_AUTH_TOKEN;
    return {
      ...this.environment,
      ANTHROPIC_API_KEY: apiKey,
      OPENCLAW_HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: input.workspace,
      NO_COLOR: "1",
    };
  }

  private credentialSource(): string | undefined {
    if (this.environment.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
    if (this.environment.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
    return undefined;
  }

  private extractText(result: OpenClawJsonResult): string {
    return (result.payloads ?? [])
      .map((payload) => payload.text)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n")
      .trim();
  }

  private extractSession(result: OpenClawJsonResult): string | undefined {
    if (typeof result.sessionKey === "string") return result.sessionKey;
    if (typeof result.sessionId === "string") return result.sessionId;
    const meta = result.meta;
    if (typeof meta?.sessionKey === "string") return meta.sessionKey;
    if (typeof meta?.sessionId === "string") return meta.sessionId;
    const nested = result.result;
    if (typeof nested?.sessionKey === "string") return nested.sessionKey;
    if (typeof nested?.sessionId === "string") return nested.sessionId;
    return undefined;
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
}
