import type { ChildProcess } from "node:child_process";

/** Agent CLIs may spawn tool processes. Use a POSIX process group so a
 * cancellation or timeout cannot leave those descendants running. */
export function processGroupOptions(): { detached: boolean } {
  return { detached: process.platform !== "win32" };
}

export function terminateProcessTree(
  child: ChildProcess,
  graceMs = 2_000,
): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.killed || !child.pid) return undefined;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid!, value);
      else child.kill(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), graceMs);
  timer.unref();
  return timer;
}
