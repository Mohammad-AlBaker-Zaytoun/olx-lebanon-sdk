import type { WriteLimits } from '../config.js';

const HOUR_MS = 60 * 60 * 1000;

export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

const realClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: () => Math.random(),
};

/**
 * Serialises write calls to OLX and spaces them out so the account behaves like a person,
 * not a bot: a minimum gap (plus random jitter) between writes and a rolling hourly cap.
 */
export class WriteRateLimiter {
  private readonly history: number[] = [];
  private nextGapMs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly limits: WriteLimits,
    private readonly clock: RateLimiterClock = realClock,
  ) {}

  /** Resolves when the caller may perform one write. Calls are granted strictly in order. */
  acquire(): Promise<void> {
    const turn = this.chain.then(() => this.waitForSlot());
    this.chain = turn.catch(() => {});
    return turn;
  }

  /** Writes performed in the last hour. */
  get recentCount(): number {
    this.prune(this.clock.now());
    return this.history.length;
  }

  private prune(now: number): void {
    while (this.history.length > 0 && now - this.history[0]! >= HOUR_MS) this.history.shift();
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.prune(now);
      let wait = 0;
      const last = this.history[this.history.length - 1];
      if (last !== undefined) wait = Math.max(wait, last + this.nextGapMs - now);
      if (this.history.length >= this.limits.maxPerHour) {
        wait = Math.max(wait, this.history[0]! + HOUR_MS - now);
      }
      if (wait <= 0) {
        this.history.push(now);
        this.nextGapMs = this.limits.minIntervalMs + Math.floor(this.clock.random() * this.limits.jitterMs);
        return;
      }
      await this.clock.sleep(wait);
    }
  }
}
