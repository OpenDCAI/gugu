import { setTimeout as delay } from 'node:timers/promises';
import { isSqliteBusy } from '@gugu/core/shared/sqliteBusy';
import type { Event } from '@gugu/core/local/session-life/types';

/** Only the decision/commit boundary can request a replay; later publication or IO cannot. */
export class UncommittedLifeEvent extends Error {
  constructor(error: unknown) { super(`Lifecycle decision could not be committed: ${String(error)}`, { cause: error }); }
}

/** Retry only an uncommitted decision, never the provider IO that produced its receipt. */
export class LifeEvents {
  private readonly queue: Event[] = [];
  private retry: Promise<void> | null = null;
  private failure: { error: unknown } | null = null;

  constructor(
    private readonly apply: (event: Event) => void,
    private readonly alive: () => boolean,
    private readonly failed: (error: unknown) => void,
  ) {}

  send(event: Event): void {
    if (this.queue.length) {
      this.queue.push(event);
      this.resume();
      return;
    }
    try { this.apply(event); }
    catch (error) {
      if (!(error instanceof UncommittedLifeEvent) || !isSqliteBusy(error)) throw error;
      this.failed(error);
      this.queue.push(event);
      this.resume();
    }
  }

  async drain(): Promise<void> {
    while (this.retry) await this.retry;
    if (this.failure) throw this.failure.error;
  }

  private resume(): void {
    if (this.retry) return;
    this.failure = null;
    this.retry = this.recover().catch(error => {
      // Keep the event for an explicit later retry and expose permanent failures to drain's caller.
      this.failure = { error };
      this.failed(error);
    }).finally(() => { this.retry = null; });
  }

  private async recover(): Promise<void> {
    let wait = 25;
    // Release the JS thread too: a writer on another connection in this process must get to commit.
    await delay(wait);
    while (this.queue.length && this.alive()) {
      try {
        this.apply(this.queue[0]!);
        this.queue.shift();
        wait = 25;
      } catch (error) {
        if (!(error instanceof UncommittedLifeEvent) || !isSqliteBusy(error)) throw error;
        wait = Math.min(wait * 2, 1_000);
        await delay(wait);
      }
    }
    if (!this.alive()) this.queue.length = 0;
  }
}
