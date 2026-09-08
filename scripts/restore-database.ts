#!/usr/bin/env node
import { access, chmod, copyFile, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { backupDatabase } from "./backup-database.ts";

function verifyDatabase(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 10_000 });
  try {
    const check = database.prepare("PRAGMA quick_check").get() as Record<string, string>;
    if (Object.values(check)[0] !== "ok") throw new Error(`database integrity check failed: ${path}`);
  } finally {
    database.close();
  }
}

export async function restoreDatabase(
  source: string,
  target: string,
): Promise<{ target: string; safetyBackup?: string }> {
  const input = resolve(source);
  const output = resolve(target);
  if (input === output) throw new Error("backup and target database must be different files");
  await access(input);
  verifyDatabase(input);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });

  for (const suffix of ["-wal", "-shm"]) {
    await access(`${output}${suffix}`).then(
      () => { throw new Error(`database sidecar exists (${output}${suffix}); stop Hibro Node cleanly before restoring`); },
      () => undefined,
    );
  }

  let safetyBackup: string | undefined;
  const targetExists = await access(output).then(() => true, () => false);
  if (targetExists) {
    const stamp = new Date().toISOString().replaceAll(":", "-");
    safetyBackup = await backupDatabase(
      output,
      join(dirname(output), "backups", `pre-restore-node-${stamp}.db`),
    );
  }

  const staging = join(dirname(output), `.${Date.now()}-${process.pid}.restore.tmp`);
  try {
    await copyFile(input, staging);
    await chmod(staging, 0o600);
    const handle = await open(staging, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    verifyDatabase(staging);
    await rename(staging, output);
    const directory = await open(dirname(output), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    verifyDatabase(output);
  } finally {
    await rm(staging, { force: true });
  }
  return safetyBackup ? { target: output, safetyBackup } : { target: output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const confirmed = process.argv.includes("--confirm-stopped");
  const source = process.argv.find((value, index) => index > 1 && !value.startsWith("--"));
  if (!confirmed || !source) {
    process.stderr.write("Usage: npm run restore -- <backup.db> --confirm-stopped\nStop Hibro Node before running this command.\n");
    process.exitCode = 2;
  } else {
    const dataDir = resolve(process.env.HIBRO_NODE_DATA_DIR ?? join(homedir(), ".hibro"));
    restoreDatabase(source, join(dataDir, "hibro.db"))
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
  }
}
