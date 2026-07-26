import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface NodeDataLayout {
  /** The complete Hibro-managed home directory. */
  root: string;
  database: string;
  settings: string;
  agentsRegistry: string;
  agentsRoot: string;
}

export function nodeDataLayout(homeDir: string): NodeDataLayout {
  const root = resolve(homeDir);
  return {
    root,
    database: join(root, "hibro.db"),
    settings: join(root, "settings.json"),
    agentsRegistry: join(root, "agents.json"),
    agentsRoot: join(root, "agents"),
  };
}

/**
 * Consolidates every Hibro-managed file beneath one home directory.
 *
 * Supported sources:
 * - <= 0.1.x: <data>/hibro.db, settings.json, agents.json and agents/
 * - early 0.2.x: <data>/.hibro/{metadata} plus <data>/agents/
 * - native default: ~/.hibro-node migrated into ~/.hibro
 *
 * Migration never overwrites an existing target. Old directories are left
 * behind when both layouts contain data so an operator can reconcile them.
 */
export async function migrateNodeDataLayout(homeDir: string): Promise<NodeDataLayout> {
  const layout = nodeDataLayout(homeDir);
  await mkdir(layout.root, { recursive: true, mode: 0o700 });
  await chmod(layout.root, 0o700);

  const legacyRoots = legacyDataRoots(layout.root);
  for (const legacyRoot of legacyRoots) {
    await migrateMetadata(join(legacyRoot, ".hibro"), layout.root);
    await removeIfEmpty(join(legacyRoot, ".hibro"));
    await migrateMetadata(legacyRoot, layout.root);
    await mergeAgentsRoot(join(legacyRoot, "agents"), layout.agentsRoot);
    await removeIfEmpty(legacyRoot);
  }

  // Custom data directories used by early 0.2 builds have a nested .hibro.
  await migrateMetadata(join(layout.root, ".hibro"), layout.root);
  await removeIfEmpty(join(layout.root, ".hibro"));

  // Docker early 0.2 layout used /data/.hibro for metadata and /data/agents
  // for Agent homes.
  if (basename(layout.root) === ".hibro") {
    await mergeAgentsRoot(join(dirname(layout.root), "agents"), layout.agentsRoot);
  }

  await migrateAgentInternals(layout.agentsRoot);
  return layout;
}

function legacyDataRoots(homeDir: string): string[] {
  if (basename(homeDir) !== ".hibro") return [];
  const parent = dirname(homeDir);
  return [join(parent, ".hibro-node")].filter(
    (candidate) => resolve(candidate) !== resolve(homeDir),
  );
}

async function migrateMetadata(sourceRoot: string, targetRoot: string): Promise<void> {
  if (resolve(sourceRoot) === resolve(targetRoot)) return;
  const databaseMoved = await moveIfTargetMissing(
    join(sourceRoot, "hibro.db"),
    join(targetRoot, "hibro.db"),
  );
  if (databaseMoved) {
    for (const name of ["hibro.db-wal", "hibro.db-shm"]) {
      await moveIfTargetMissing(join(sourceRoot, name), join(targetRoot, name));
    }
  }
  for (const name of ["settings.json", "agents.json", "runs"]) {
    await moveIfTargetMissing(join(sourceRoot, name), join(targetRoot, name));
  }
}

async function mergeAgentsRoot(sourceRoot: string, targetRoot: string): Promise<void> {
  if (resolve(sourceRoot) === resolve(targetRoot)) return;
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const sourceAgent = join(sourceRoot, entry.name);
    const targetAgent = join(targetRoot, entry.name);
    const moved = await moveIfTargetMissing(sourceAgent, targetAgent);
    if (!moved) {
      await mergeAgentDirectory(sourceAgent, targetAgent);
    }
  }
  await removeIfEmpty(sourceRoot);
}

async function mergeAgentDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of ["workspace", "artifacts", "state", "tmp", "runs", ".hibro"]) {
    await moveIfTargetMissing(join(source, name), join(target, name));
  }
}

async function migrateAgentInternals(agentsRoot: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const agentRoot = join(agentsRoot, entry.name);
    const nestedMetadata = join(agentRoot, ".hibro");
    for (const name of ["state", "tmp", "runs"]) {
      await moveIfTargetMissing(
        join(nestedMetadata, name),
        join(agentRoot, name),
      );
    }
    await removeIfEmpty(nestedMetadata);
    await chmod(agentRoot, 0o700);
    await repairAgentGitPointers(agentRoot);
  }
}

async function moveIfTargetMissing(source: string, target: string): Promise<boolean> {
  try {
    await access(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rename(source, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function removeIfEmpty(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw error;
    }
  }
}

async function repairAgentGitPointers(agentRoot: string): Promise<void> {
  const homeParent = dirname(dirname(dirname(agentRoot)));
  const agentId = basename(agentRoot);
  const replacements = [
    [join(homeParent, "agents", agentId), agentRoot],
    [join(homeParent, ".hibro-node", "agents", agentId), agentRoot],
    [join(agentRoot, ".hibro"), agentRoot],
  ] as const;
  await replacePaths(join(agentRoot, "workspace", ".git"), replacements);
  let runs: Dirent[];
  try {
    runs = await readdir(join(agentRoot, "runs"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    runs = [];
  }
  for (const entry of runs) {
    if (!entry.isDirectory()) continue;
    await replacePaths(
      join(agentRoot, "runs", entry.name, "workspace", ".git"),
      replacements,
    );
    await replacePaths(
      join(agentRoot, "runs", entry.name, "scratch", ".git"),
      replacements,
    );
  }

  let worktrees;
  const worktreesRoot = join(agentRoot, "state", "source.git", "worktrees");
  try {
    worktrees = await readdir(worktreesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of worktrees) {
    if (!entry.isDirectory()) continue;
    await replacePaths(join(worktreesRoot, entry.name, "gitdir"), replacements);
  }
}

async function replacePaths(
  path: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  try {
    const content = await readFile(path, "utf8");
    let repaired = content;
    for (const [from, to] of replacements) {
      repaired = repaired.replaceAll(resolve(from), resolve(to));
    }
    if (repaired !== content) await writeFile(path, repaired, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
