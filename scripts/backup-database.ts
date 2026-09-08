#!/usr/bin/env node
import { chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export async function backupDatabase(source: string, destination: string): Promise<string> {
  const input = resolve(source);
  const output = resolve(destination);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(input, { readOnly: true, timeout: 10_000 });
  try {
    const check = database.prepare("PRAGMA quick_check").get() as Record<string, string>;
    if (Object.values(check)[0] !== "ok") throw new Error("source database integrity check failed");
    database.exec(`VACUUM INTO '${output.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
  const verification = new DatabaseSync(output, { readOnly: true });
  try {
    const check = verification.prepare("PRAGMA quick_check").get() as Record<string, string>;
    if (Object.values(check)[0] !== "ok") throw new Error("backup integrity check failed");
  } finally {
    verification.close();
  }
  await chmod(output, 0o600);
  return output;
}

export async function pruneBackups(directory: string, prefix: string, keep = 14): Promise<void> {
  const entries = (await readdir(directory).catch(() => []))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".db"))
    .sort()
    .reverse();
  await Promise.all(entries.slice(keep).map((name) => unlink(join(directory, name))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = resolve(process.env.HIBRO_NODE_DATA_DIR ?? join(homedir(), ".hibro"));
  const source = join(dataDir, "hibro.db");
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const destination = resolve(process.argv[2] ?? join(dataDir, "backups", `hibro-node-${stamp}.db`));
  backupDatabase(source, destination)
    .then((path) => process.stdout.write(`${path}\n`))
    .catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
