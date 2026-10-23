import type { ActivityObservation } from '@shared/core/activity';

/** A producer's report: typed metadata only, never a project (the journal derives it from the subject). */
export type ActivitySignal = Omit<ActivityObservation, 'observed_at'>;
const listeners = new Set<(event: ActivitySignal) => void>();
/** Producers send only typed metadata, after their original fact is committed. */
export function activitySignal(event: ActivitySignal): void { for (const listener of listeners) listener(event); }
export function onActivitySignal(listener: (event: ActivitySignal) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
