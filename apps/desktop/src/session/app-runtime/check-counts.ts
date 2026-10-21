import type { PageCounts } from '@shared/extensions/bridge-protocol';
import type { GuguHost } from './host';

/**
 * The page `app_check` runs (摩擦单 F69) opens its files as anywhere — by whoever works it (owner 10-14). How often it
 * wrote, set presence and opened files, it reports to the host for the check to read back (S16: 59.8 writes a second
 * for 5 s; F5: the check reads the page only once its opens settled).
 */

const REPORT_MS = 250;

class PageCounter {
  private readonly counts: PageCounts = { writes: 0, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 0, opensSettled: 0 };
  private readonly recent = { writes: [] as number[], presence: [] as number[] };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly host: GuguHost) {}

  wrote(): void {
    this.counts.writes += 1;
    this.counts.writesPerSecond = Math.max(this.counts.writesPerSecond, this.inLastSecond(this.recent.writes));
    this.schedule();
  }

  setPresence(): void {
    this.counts.presenceSets += 1;
    this.counts.presencePerSecond = Math.max(this.counts.presencePerSecond, this.inLastSecond(this.recent.presence));
    this.schedule();
  }

  /** `files.open` called (摩擦单 F5: the check waits for the page's opens to settle before it reads the page). */
  opened(): void {
    this.counts.opens += 1;
    this.schedule();
  }

  /** A `files.open` resolved or rejected: said at once, not on the next beat — the check is waiting for it. */
  openSettled(): void {
    this.counts.opensSettled += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.report();
  }

  private inLastSecond(times: number[]): number {
    const now = Date.now();
    times.push(now);
    while (times.length > 0 && times[0]! <= now - 1000) times.shift();
    return times.length;
  }

  /** At most every REPORT_MS: the check reads the latest when it ends. */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.report();
    }, REPORT_MS);
  }

  private report(): void {
    void this.host.checkPage?.report({ ...this.counts }).catch(() => undefined);
  }
}

const counters = new WeakMap<GuguHost, PageCounter>();

/** The check's page's counter, or null on any other page. */
export function countsOf(host: GuguHost): PageCounter | null {
  if (!host.checkPage) return null;
  let counter = counters.get(host);
  if (!counter) counters.set(host, (counter = new PageCounter(host)));
  return counter;
}
