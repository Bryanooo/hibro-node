export class PausableExecutionTimeout {
  private timer: NodeJS.Timeout | undefined;
  private startedAt = 0;
  private remainingMs: number | undefined;
  private fired = false;
  private readonly onTimeout: () => void;

  constructor(timeoutMs: number | undefined, onTimeout: () => void) {
    this.remainingMs = timeoutMs;
    this.onTimeout = onTimeout;
  }

  start(): void {
    this.resume();
  }

  pause(): void {
    if (!this.timer || this.remainingMs === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = Math.max(
      0,
      this.remainingMs - (Date.now() - this.startedAt),
    );
  }

  resume(): void {
    if (this.remainingMs === undefined || this.timer || this.fired) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.remainingMs = 0;
      this.fired = true;
      this.onTimeout();
    }, Math.max(0, this.remainingMs));
    this.timer.unref();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
