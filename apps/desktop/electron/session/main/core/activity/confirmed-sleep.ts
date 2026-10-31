export type ConfirmedSleep = { since: number; until: number; source: 'native-power' | 'fc-confirmed' };

const resumeListeners = new Set<(sleep: ConfirmedSleep) => void>();
export function publishConfirmedSleep(sleep: ConfirmedSleep): void {
  if (!Number.isFinite(sleep.since) || !Number.isFinite(sleep.until) || sleep.until <= sleep.since) return;
  for (const listener of resumeListeners) listener(sleep);
}
export function onConfirmedSleep(listener: (sleep: ConfirmedSleep) => void): () => void {
  resumeListeners.add(listener);
  return () => { resumeListeners.delete(listener); };
}

/** Remove only attested suspension from capture coverage. Heartbeat gaps, an App
 * becoming foreground and an event-loop stall do not attest device sleep. */
export function withoutSleep<T extends { started_at: number; last_seen_at: number; ended_at: number | null }>(
  segments: T[], sleeps: ConfirmedSleep[],
): T[] {
  let result = segments;
  for (const sleep of sleeps) {
    result = result.flatMap(segment => {
      const end = segment.ended_at ?? segment.last_seen_at;
      if (sleep.until <= segment.started_at || sleep.since >= end) return [segment];
      const parts: T[] = [];
      if (sleep.since > segment.started_at) parts.push({ ...segment, last_seen_at: sleep.since, ended_at: sleep.since });
      if (sleep.until < end) parts.push({ ...segment, started_at: sleep.until });
      return parts;
    });
  }
  return result;
}
