import { access, cp, mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";
import type {
  AgentDefinition,
  AgentSource,
  WorkspaceLease,
  WorkspaceStrategy,
} from "./domain.ts";
import { createId } from "./identity.ts";

export class WorkspaceBusyError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} is already running at its concurrency limit`);
    this.name = "WorkspaceBusyError";
  }
}

export interface AgentRuntimePaths {
  root: string;
  workspace: string;
  metadata: string;
  state: string;
  temp: string;
  artifacts: string;
  runs: string;
}

export class WorkspaceManager {
  private readonly rootDir: string;
  private readonly activeByAgent = new Map<string, Set<string>>();
  private readonly activeByPath = new Map<string, string>();
  private readonly gitOperations = new Map<string, Promise<unknown>>();

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  pathsFor(agentId: string): AgentRuntimePaths {
    const root = join(this.rootDir, agentId);
    return {
      root,
      workspace: join(root, "workspace"),
      metadata: root,
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

  async acquire(
    agent: AgentDefinition,
    runId: string,
    sourceOverride?: AgentSource,
  ): Promise<WorkspaceLease> {
    const active = this.activeByAgent.get(agent.id) ?? new Set<string>();
    if (active.size >= agent.maxConcurrency) throw new WorkspaceBusyError(agent.id);
    active.add(runId);
    this.activeByAgent.set(agent.id, active);
    try {
      const source = sourceOverride ?? agent.source;
      if (source) await access(source.path);
      const paths = this.pathsFor(agent.id);
      await Promise.all([
        mkdir(paths.state, { recursive: true }),
        mkdir(paths.temp, { recursive: true }),
        mkdir(paths.artifacts, { recursive: true }),
      ]);
      const strategy: WorkspaceStrategy = sourceOverride
        ? "per-run"
        : agent.workspace.strategy;
      const workspace = await this.resolveWorkspace(
        strategy,
        source,
        runId,
        paths,
      );
      if (this.activeByPath.has(workspace.path)) throw new WorkspaceBusyError(agent.id);
      this.activeByPath.set(workspace.path, runId);
      return {
        id: createId("lease"),
        strategy,
        access: agent.workspace.access,
        path: workspace.path,
        ...(source ? { sourcePath: source.path } : {}),
        gitRepositoryPath: workspace.gitRepositoryPath,
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
      const repositoryPath = lease.gitRepositoryPath ?? lease.sourcePath;
      if (!repositoryPath) {
        throw new Error("Git workspace lease is missing its repository path");
      }
      try {
        await this.withGitRepository(repositoryPath, async () => {
          await this.git(repositoryPath, ["worktree", "remove", "--force", lease.path]);
        });
      } catch (error) {
        await rm(lease.path, { recursive: true, force: true });
        await this.withGitRepository(repositoryPath, async () => {
          await this.git(repositoryPath, ["worktree", "prune"]);
        }).catch(() => undefined);
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
    strategy: WorkspaceStrategy,
    source: AgentSource | undefined,
    runId: string,
    paths: AgentRuntimePaths,
  ): Promise<{
    path: string;
    materialization: WorkspaceLease["materialization"];
    gitRepositoryPath?: string | undefined;
  }> {
    if (strategy === "scratch") {
      const path = join(paths.runs, runId, "scratch");
      await mkdir(path, { recursive: true });
      return { path, materialization: "scratch" };
    }
    const path =
      strategy === "persistent"
        ? paths.workspace
        : join(paths.runs, runId, "workspace");
    if (!source) {
      await mkdir(path, { recursive: true });
      return { path, materialization: "empty" };
    }
    return this.materialize(source.path, path, paths.state);
  }

  private async materialize(
    sourcePath: string,
    targetPath: string,
    statePath: string,
  ): Promise<{
    path: string;
    materialization: WorkspaceLease["materialization"];
    gitRepositoryPath?: string | undefined;
  }> {
    let targetExists = true;
    try {
      await access(targetPath);
    } catch {
      targetExists = false;
    }
    if (targetExists && (await readdir(targetPath)).length > 0) {
      const gitWorkspace = await this.isGitWorkspace(targetPath);
      let gitRepositoryPath: string | undefined;
      if (gitWorkspace) {
        const managedRepositoryPath = join(statePath, "source.git");
        try {
          await access(join(managedRepositoryPath, "HEAD"));
          gitRepositoryPath = managedRepositoryPath;
        } catch {
          gitRepositoryPath = undefined;
        }
      }
      return {
        path: targetPath,
        materialization: gitWorkspace ? "git-worktree" : "directory-copy",
        gitRepositoryPath,
      };
    }
    if (targetExists) await rm(targetPath, { recursive: true });
    await mkdir(resolve(targetPath, ".."), { recursive: true });
    if (await this.hasGitHead(sourcePath)) {
      const gitRepositoryPath = join(statePath, "source.git");
      try {
        await this.withGitRepository(gitRepositoryPath, async () => {
          await this.prepareManagedRepository(sourcePath, gitRepositoryPath);
          await this.git(gitRepositoryPath, [
            "worktree",
            "add",
            "--detach",
            targetPath,
            "refs/hibro/source",
          ]);
        });
      } catch (error) {
        await rm(targetPath, { recursive: true, force: true });
        throw error;
      }
      return { path: targetPath, materialization: "git-worktree", gitRepositoryPath };
    }
    await cp(sourcePath, targetPath, {
      recursive: true,
      filter: (source) => basename(source) !== ".git",
    });
    return { path: targetPath, materialization: "directory-copy" };
  }

  private async prepareManagedRepository(
    sourcePath: string,
    repositoryPath: string,
  ): Promise<void> {
    try {
      await access(join(repositoryPath, "HEAD"));
    } catch {
      await mkdir(repositoryPath, { recursive: true });
      await this.git(repositoryPath, ["init", "--bare"]);
    }
    await this.git(repositoryPath, [
      "fetch",
      "--force",
      "--no-tags",
      sourcePath,
      "HEAD:refs/hibro/source",
    ]);
    await this.git(repositoryPath, ["worktree", "prune"]);
  }

  private async withGitRepository<T>(
    repositoryPath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.gitOperations.get(repositoryPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.gitOperations.set(repositoryPath, current);
    try {
      return await current;
    } finally {
      if (this.gitOperations.get(repositoryPath) === current) {
        this.gitOperations.delete(repositoryPath);
      }
    }
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
