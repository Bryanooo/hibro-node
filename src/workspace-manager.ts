import { access, cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentDefinition, WorkspaceLease } from "./domain.ts";

export class WorkspaceBusyError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} is already running at its concurrency limit`);
    this.name = "WorkspaceBusyError";
  }
}

export interface AgentRuntimePaths {
  root: string;
  workspace: string;
  state: string;
  temp: string;
  artifacts: string;
  runs: string;
}

export class WorkspaceManager {
  private readonly rootDir: string;
  private readonly activeByAgent = new Map<string, Set<string>>();
  private readonly activeByPath = new Map<string, string>();

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  pathsFor(agentId: string): AgentRuntimePaths {
    const root = join(this.rootDir, agentId);
    return {
      root,
      workspace: join(root, "workspace"),
      state: join(root, "state"),
      temp: join(root, "tmp"),
      artifacts: join(root, "artifacts"),
      runs: join(root, "runs"),
    };
  }

  expectedWorkspacePath(agent: AgentDefinition): string {
    const paths = this.pathsFor(agent.id);
    if (agent.workspace.strategy === "persistent") return paths.workspace;
    if (agent.workspace.strategy === "scratch") return join(paths.runs, "<run-id>", "scratch");
    return join(paths.runs, "<run-id>", "workspace");
  }

  async acquire(agent: AgentDefinition, runId: string): Promise<WorkspaceLease> {
    const active = this.activeByAgent.get(agent.id) ?? new Set<string>();
    if (active.size >= agent.maxConcurrency) throw new WorkspaceBusyError(agent.id);
    active.add(runId);
    this.activeByAgent.set(agent.id, active);
    try {
      await access(agent.source.path);
      const paths = this.pathsFor(agent.id);
      await Promise.all([
        mkdir(paths.state, { recursive: true }),
        mkdir(paths.temp, { recursive: true }),
        mkdir(paths.artifacts, { recursive: true }),
      ]);
      const workspace = await this.resolveWorkspace(agent, runId, paths);
      if (this.activeByPath.has(workspace.path)) throw new WorkspaceBusyError(agent.id);
      this.activeByPath.set(workspace.path, runId);
      return {
        id: randomUUID(),
        strategy: agent.workspace.strategy,
        access: agent.workspace.access,
        path: workspace.path,
        sourcePath: agent.source.path,
        statePath: paths.state,
        tempPath: paths.temp,
        materialization: workspace.materialization,
        writable: agent.workspace.access === "workspace-write",
      };
    } catch (error) {
      active.delete(runId);
      if (active.size === 0) this.activeByAgent.delete(agent.id);
      throw error;
    }
  }

  async release(agentId: string, runId: string, lease?: WorkspaceLease): Promise<void> {
    const active = this.activeByAgent.get(agentId);
    active?.delete(runId);
    if (active?.size === 0) this.activeByAgent.delete(agentId);
    if (lease && this.activeByPath.get(lease.path) === runId) this.activeByPath.delete(lease.path);
    if (!lease || lease.strategy === "persistent") return;
    if (lease.materialization === "git-worktree") {
      try {
        await this.git(lease.sourcePath, ["worktree", "remove", "--force", lease.path]);
      } catch (error) {
        await rm(lease.path, { recursive: true, force: true });
        await this.git(lease.sourcePath, ["worktree", "prune"]).catch(() => undefined);
        throw error;
      }
      return;
    }
    await rm(lease.path, { recursive: true, force: true });
  }

  activeRunIds(agentId: string): string[] {
    return [...(this.activeByAgent.get(agentId) ?? [])];
  }

  private async resolveWorkspace(
    agent: AgentDefinition,
    runId: string,
    paths: AgentRuntimePaths,
  ): Promise<{ path: string; materialization: WorkspaceLease["materialization"] }> {
    if (agent.workspace.strategy === "scratch") {
      const path = join(paths.runs, runId, "scratch");
      await mkdir(path, { recursive: true });
      return { path, materialization: "scratch" };
    }
    const path =
      agent.workspace.strategy === "persistent"
        ? paths.workspace
        : join(paths.runs, runId, "workspace");
    return { path, materialization: await this.materialize(agent.source.path, path) };
  }

  private async materialize(
    sourcePath: string,
    targetPath: string,
  ): Promise<WorkspaceLease["materialization"]> {
    try {
      await access(targetPath);
      return (await this.isGitWorkspace(targetPath)) ? "git-worktree" : "directory-copy";
    } catch {
      await mkdir(resolve(targetPath, ".."), { recursive: true });
    }
    if (await this.hasGitHead(sourcePath)) {
      await this.git(sourcePath, ["worktree", "add", "--detach", targetPath, "HEAD"]);
      return "git-worktree";
    }
    await cp(sourcePath, targetPath, {
      recursive: true,
      filter: (source) => basename(source) !== ".git",
    });
    return "directory-copy";
  }

  private async hasGitHead(path: string): Promise<boolean> {
    try {
      await this.git(path, ["rev-parse", "--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  private async isGitWorkspace(path: string): Promise<boolean> {
    try {
      await access(join(path, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  private async git(cwd: string, args: string[]): Promise<void> {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolvePromise(value ?? 1));
    });
    if (code !== 0) throw new Error(stderr.trim() || `git exited with code ${code}`);
  }
}
