import type { ActivityEvent } from '@shared/core/activity';

type Signal = Omit<ActivityEvent, 'observed_at'>;
const listeners = new Set<(event: Signal) => void>();
/** Producers send only typed metadata, after their original fact is committed. */
export function activitySignal(event: Signal): void { for (const listener of listeners) listener(event); }
export function onActivitySignal(listener: (event: Signal) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
