import type { SerializedError } from '@gugu/core/local/session-life/types';
import type { PendingRow } from './session-life-adapter';

/**
 * What only the gugu host can do for a pending row's cloud sources: mark them read once the agent accepted the row,
 * and tell the sources once that it could not. Registered by the host at boot, like the MCP injector.
 */
export interface SessionLifeSourceHost {
  markRead(row: PendingRow): Promise<void>;
  reportFailure(rows: readonly PendingRow[], cause: SerializedError): Promise<void>;
}

let host: SessionLifeSourceHost | null = null;

export function setSessionLifeSourceHost(next: SessionLifeSourceHost | null): void {
  host = next;
}

/** A row without sources has nothing to mark or report outside this device; its receipt is the whole story. */
export const sessionLifeSources: SessionLifeSourceHost = {
  async markRead(row) {
    if (!row.sources.length) return;
    if (!host) throw new Error('session-life source host is not installed');
    await host.markRead(row);
  },
  async reportFailure(rows, cause) {
    const sourced = rows.filter(row => row.sources.length);
    if (!sourced.length) return;
    if (!host) throw new Error('session-life source host is not installed');
    await host.reportFailure(sourced, cause);
  },
};
