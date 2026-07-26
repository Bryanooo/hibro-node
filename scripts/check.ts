import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

async function check(path: string): Promise<void> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--check", path], {
    stdio: "inherit",
  });
  const code = await new Promise<number>((resolve) =>
    child.once("close", (value) => resolve(value ?? 1)),
  );
  if (code !== 0) throw new Error(`Syntax check failed: ${path}`);
}

for (const directory of ["src", "test", "scripts"]) {
  for (const path of await collect(directory)) {
    await check(path);
  }
}
process.stdout.write("Syntax check passed\n");

