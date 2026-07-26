import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export interface NodeDataLayout {
  root: string;
  metadata: string;
  database: string;
  settings: string;
  agentsRegistry: string;
  agentsRoot: string;
}

export function nodeDataLayout(dataDir: string): NodeDataLayout {
  const root = resolve(dataDir);
  const metadata = join(root, ".hibro");
  return {
    root,
    metadata,
    database: join(metadata, "hibro.db"),
    settings: join(metadata, "settings.json"),
    agentsRegistry: join(metadata, "agents.json"),
    agentsRoot: join(root, "agents"),
  };
}

/**
 * Moves metadata created by Hibro Node <= 0.1.x into hidden directories.
 * Every move stays inside the same data volume and never overwrites a target.
 */
export async function migrateNodeDataLayout(dataDir: string): Promise<NodeDataLayout> {
  const layout = nodeDataLayout(dataDir);
  await mkdir(layout.metadata, { recursive: true, mode: 0o700 });
  await chmod(layout.metadata, 0o700);

  const databaseMoved = await moveIfTargetMissing(
    join(layout.root, "hibro.db"),
    layout.database,
  );
  if (databaseMoved) {
    for (const name of ["hibro.db-wal", "hibro.db-shm"]) {
      await moveIfTargetMissing(join(layout.root, name), join(layout.metadata, name));
    }
  }
  for (const name of ["settings.json", "agents.json", "runs"]) {
    await moveIfTargetMissing(join(layout.root, name), join(layout.metadata, name));
  }

  await migrateAgentMetadata(layout.agentsRoot);
  return layout;
}

async function migrateAgentMetadata(agentsRoot: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(agentsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const root = join(agentsRoot, entry.name);
    const metadata = join(root, ".hibro");
    await mkdir(metadata, { recursive: true, mode: 0o700 });
    await chmod(metadata, 0o700);
    const oldState = join(root, "state");
    const newState = join(metadata, "state");
    await moveIfTargetMissing(oldState, newState);
    await moveIfTargetMissing(join(root, "tmp"), join(metadata, "tmp"));
    await moveIfTargetMissing(join(root, "runs"), join(metadata, "runs"));
    await repairWorktreePointer(join(root, "workspace", ".git"), oldState, newState);
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

async function repairWorktreePointer(
  gitFile: string,
  oldStatePath: string,
  newStatePath: string,
): Promise<void> {
  try {
    const content = await readFile(gitFile, "utf8");
    const repaired = content.replace(
      `${resolve(oldStatePath)}/`,
      `${resolve(newStatePath)}/`,
    );
    if (repaired !== content) await writeFile(gitFile, repaired, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
