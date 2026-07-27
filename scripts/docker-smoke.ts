#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { get } from "node:http";

interface CommandResult {
  stdout: string;
  stderr: string;
}

async function command(
  executable: string,
  args: string[],
  options: { showOutput?: boolean } = {},
): Promise<CommandResult> {
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: options.showOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${executable} 被信号 ${signal} 终止`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} 执行失败 (${exitCode})\n${stderr || stdout}`,
    );
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function waitForHealth(baseURL: string, container: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "服务尚未响应";
  while (Date.now() < deadline) {
    try {
      const status = await requestStatus(`${baseURL}/health`);
      if (status >= 200 && status < 300) return;
      lastError = `HTTP ${status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  const logs = await command("docker", ["logs", container]).catch((error: unknown) => ({
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  throw new Error(`Docker 健康检查超时：${lastError}\n${logs.stdout}\n${logs.stderr}`);
}

async function requestStatus(url: string): Promise<number> {
  return new Promise<number>((resolveStatus, reject) => {
    const request = get(url, { agent: false }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.setTimeout(2_000, () => {
      request.destroy(new Error("HTTP 健康检查超时"));
    });
    request.once("error", reject);
  });
}

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  headers.set("connection", "close");
  const response = await fetch(url, {
    ...options,
    headers,
    signal: options?.signal ?? AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${body}`);
  return JSON.parse(body) as T;
}

async function containerBaseURL(container: string): Promise<string> {
  const portResult = await command("docker", ["port", container, "7331/tcp"]);
  const port = portResult.stdout.match(/:(\d+)$/)?.[1];
  assert.ok(port, `无法解析 Docker 映射端口：${portResult.stdout}`);
  return `http://127.0.0.1:${port}`;
}

async function main(): Promise<void> {
  const suffix = `${process.pid}-${Date.now()}`;
  const suppliedImage = process.env.HIBRO_DOCKER_SMOKE_IMAGE;
  const image = suppliedImage ?? `hibro-node-smoke:${suffix}`;
  const container = `hibro-node-smoke-${suffix}`;
  const volume = `hibro-node-smoke-data-${suffix}`;
  let containerCreated = false;
  let volumeCreated = false;

  try {
    if (!suppliedImage) {
      process.stdout.write(`构建临时镜像 ${image}\n`);
      await command("docker", ["build", "--tag", image, "."], { showOutput: true });
    }
    await command("docker", ["volume", "create", volume]);
    volumeCreated = true;
    await command("docker", [
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::7331",
      "--volume",
      `${volume}:/data`,
      image,
    ]);
    containerCreated = true;

    let baseURL = await containerBaseURL(container);
    await waitForHealth(baseURL, container);
    process.stdout.write("容器已健康启动，验证运行时和数据布局\n");

    const system = await json<{
      dataDir: string;
      container: boolean;
      storage: { engine: string; databasePath: string };
    }>(`${baseURL}/v1/system`);
    assert.equal(system.container, true);
    assert.equal(system.dataDir, "/data/.hibro");
    assert.equal(system.storage.engine, "sqlite");
    assert.equal(system.storage.databasePath, "/data/.hibro/hibro.db");

    const agents = await json<{
      agents: Array<{ agent: { id: string; engine: string; source?: unknown } }>;
    }>(`${baseURL}/v1/agents`);
    assert.equal(agents.agents.length, 6);
    assert.deepEqual(
      [...new Set(agents.agents.map((item) => item.agent.engine))].sort(),
      ["claude-code", "codex", "openclaw"],
    );

    const workspaces = await json<{
      workspaces: Array<{
        agentId: string;
        path: string;
        metadataPath: string;
        statePath: string;
      }>;
    }>(`${baseURL}/v1/workspaces`);
    assert.equal(workspaces.workspaces.length, 6);
    assert.equal(new Set(workspaces.workspaces.map((item) => item.path)).size, 6);
    for (const workspace of workspaces.workspaces) {
      assert.match(
        workspace.path,
        new RegExp(`^/data/\\.hibro/agents/${workspace.agentId}/`),
      );
      assert.equal(
        workspace.metadataPath,
        `/data/.hibro/agents/${workspace.agentId}`,
      );
      assert.equal(
        workspace.statePath,
        `/data/.hibro/agents/${workspace.agentId}/state`,
      );
    }

    const created = await json<{ id: string }>(`${baseURL}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Docker Smoke Agent",
        engine: "codex",
        source: null,
        workspace: { strategy: "persistent", access: "workspace-write" },
        maxConcurrency: 1,
        enabled: true,
      }),
    });
    assert.match(created.id, /^agt_[0-9a-f-]{36}$/);
    process.stdout.write("临时 Agent 已创建，重启容器验证数据卷持久化\n");

    await command("docker", ["restart", container]);
    process.stdout.write("容器已完成重启，等待健康检查\n");
    baseURL = await containerBaseURL(container);
    await waitForHealth(baseURL, container);
    process.stdout.write("重启后服务已恢复，读取 Agent 配置\n");
    const persisted = await json<{
      agents: Array<{ agent: { id: string } }>;
    }>(`${baseURL}/v1/agents`);
    assert.ok(
      persisted.agents.some((item) => item.agent.id === created.id),
      "容器重启后 Agent 配置必须仍在数据卷中",
    );

    process.stdout.write(
      "Docker smoke passed: image startup, SQLite, /data/.hibro, isolated workspaces and restart persistence\n",
    );
  } finally {
    if (containerCreated) {
      await command("docker", ["rm", "--force", container]).catch(() => undefined);
    }
    if (volumeCreated) {
      await command("docker", ["volume", "rm", volume]).catch(() => undefined);
    }
    if (!suppliedImage) {
      await command("docker", ["image", "rm", image]).catch(() => undefined);
    }
  }
}

await main();
