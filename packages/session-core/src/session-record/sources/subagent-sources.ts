import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import type { RecordEntry, SessionRecordResume, SessionRecordSource, SessionRecordSourceEvents } from '../contract';
import type { SessionRecordSourceOptions } from './shared';

/** Follow native child records through the same lifecycle and stream projection as Codex. */
export function withSubagentSources(
  root: SessionRecordSource,
  createChild: (id: string) => SessionRecordSource,
  recreate: () => SessionRecordSource,
  options?: SessionRecordSourceOptions,
): SessionRecordSource {
  const children = new Map<string, SessionRecordSource>();
  const starting = new Map<string, Promise<void>>();
  const childIds = new Set<string>();
  let stopped = false;
  let initializing = true;
  let sink: SessionRecordSourceEvents | null = null;
  let replacement: SessionRecordSource | null = null;
  let childResumes: Record<string, SessionRecordResume> = {};

  const stopChildren = () => {
    for (const source of children.values()) source.stop();
    children.clear();
  };
  const restart = async (reason: 'source_replaced' | 'source_unreadable') => {
    if (stopped || replacement || !sink) return;
    root.stop();
    stopChildren();
    sink.onReset(reason);
    replacement = recreate();
    await replacement.start(sink);
  };
  const ensureChild = (id: string): Promise<void> => {
    if (stopped || children.has(id)) return Promise.resolve();
    const pending = starting.get(id);
    if (pending) return pending;
    const source = createChild(id);
    children.set(id, source);
    const read = source.start({
      onEntries(entries) {
        const mapped: RecordEntry[] = entries.map((entry): RecordEntry => {
          if (entry.boundary) return { key: entry.key, at: entry.at, event: childState(id,
            entry.boundary.kind === 'turn_failed' ? 'failed' : entry.boundary.kind === 'turn_aborted' ? 'stopped' : 'completed') };
          const event = entry.event;
          // A nested launch belongs to this child's stream; nested lifecycle facts already name their own child.
          if (event.kind === 'subagent_update' || event.kind === 'subagent_done' || event.kind === 'subagent_stream') return entry;
          if (event.kind === 'message' && event.role === 'user') return { key: entry.key, at: entry.at, event: childState(id, 'in_progress') };
          return { ...entry, event: { kind: 'subagent_stream', subagentSessionId: id, event } };
        });
        if (!stopped && children.get(id) === source) sink?.onEntries(mapped);
      },
      onReset: (reason) => { void restart(reason).catch((error: unknown) => options?.warn?.('Native child record restart failed', { error: String(error) })); },
    }, childResumes[id]).catch((error: unknown) => {
      if (children.get(id) === source) children.delete(id);
      options?.warn?.('Native child record read failed', { childId: id, error: String(error) });
      throw error;
    }).finally(() => starting.delete(id));
    starting.set(id, read);
    return read;
  };
  return {
    locator: root.locator,
    async start(events, resume) {
      sink = events;
      const saved = resume?.data as { nativeChildren?: number; root?: SessionRecordResume; children?: Record<string, SessionRecordResume> } | undefined;
      childResumes = saved?.nativeChildren === 2 ? saved.children ?? {} : {};
      for (const id of Object.keys(childResumes)) childIds.add(id);
      await root.start({ ...events,
        onReset(reason) {
          stopChildren();
          childIds.clear();
          childResumes = {};
          events.onReset(reason);
        },
        onEntries(entries) {
          events.onEntries(entries);
          // Deliver the launch before its child records so the reducer can resolve their owner.
          for (const entry of entries) {
            if (entry.event?.kind === 'subagent' && entry.event.subagentSessionId) childIds.add(entry.event.subagentSessionId);
          }
          if (!initializing) for (const id of childIds) {
            void ensureChild(id).catch((error: unknown) => events.onEntries([{ key: `native-child-error:${id}`, event: childState(id, 'disconnected', String(error)) }]));
          }
        },
      }, saved?.nativeChildren === 2 ? saved.root : resume);
      initializing = false;
      await Promise.all([...childIds].map(ensureChild));
      await Promise.all(starting.values());
    },
    async catchUp() { if (replacement) return replacement.catchUp?.(); await root.catchUp?.(); await Promise.all(starting.values()); await Promise.all([...children.values()].map((child) => child.catchUp?.())); },
    async resumePoint() {
      if (replacement) return replacement.resumePoint!();
      // The host starts archiving and immediately stops the source. Start every
      // cursor read before yielding, while the child sources still own their readers.
      const [point, childPoints] = await Promise.all([
        root.resumePoint!(),
        Promise.all([...children].map(async ([id, child]) => [id, await child.resumePoint?.()] as const)),
      ]);
      if (!point) return null;
      const savedChildren = Object.fromEntries(childPoints.filter((point): point is readonly [string, SessionRecordResume] => Boolean(point[1])));
      return { data: { nativeChildren: 2, root: point, children: savedChildren }, fingerprint: [point.fingerprint, ...Object.entries(savedChildren).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `${id}:${value.fingerprint}`)].join('|') };
    },
    stop() { stopped = true; replacement?.stop(); root.stop(); stopChildren(); },
  };
}

/** Recorded children cannot be interrupted; their own boundaries decide their outcome. */
export function childState(id: string, status: 'in_progress' | 'completed' | 'failed' | 'stopped' | 'disconnected', summary?: string): NormalizedEvent {
  if (status === 'in_progress') return {
    kind: 'subagent_update', toolCallId: id, agentId: id, subagentSessionId: id,
    status, canCancel: false,
  };
  return {
    kind: 'subagent_done', toolCallId: id, agentId: id, subagentSessionId: id,
    ...(summary ? { summary } : {}), status,
  };
}
