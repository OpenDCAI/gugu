import { subagentUpdate } from '@gugu/core/shared/subagentUpdates.mjs';

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
        const mapped: RecordEntry[] = entries.flatMap((entry): RecordEntry[] => {
          if (entry.boundary) return [{ key: entry.key, at: entry.at, update: subagentUpdate({
            sessionUpdate: 'subagent_state_update', subagentSessionId: id,
            state: entry.boundary.kind === 'turn_failed' ? 'failed' : entry.boundary.kind === 'turn_aborted' ? 'cancelled' : 'completed',
          }) }];
          const inner = entry.update._meta?.['gugu.draftSessionUpdate'] as { sessionUpdate?: string } | undefined;
          if (inner && inner.sessionUpdate !== 'subagent_spawned') return [entry];
          if (entry.update.sessionUpdate === 'user_message_chunk') return [{ key: entry.key, at: entry.at, update: subagentUpdate({
            sessionUpdate: 'subagent_state_update', subagentSessionId: id, state: 'running', canCancel: false,
          }) }];
          return [{ ...entry, update: subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: id, update: entry.update }) }];
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
      childResumes = saved?.nativeChildren === 1 ? saved.children ?? {} : {};
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
            const inner = entry.update?._meta?.['gugu.draftSessionUpdate'] as { sessionUpdate?: string; subagentSessionId?: string } | undefined;
            if (inner?.sessionUpdate === 'subagent_spawned' && inner.subagentSessionId) childIds.add(inner.subagentSessionId);
          }
          if (!initializing) for (const id of childIds) {
            void ensureChild(id).catch((error: unknown) => events.onEntries([{ key: `native-child-error:${id}`, update: subagentUpdate({
              sessionUpdate: 'subagent_state_update', subagentSessionId: id, state: 'disconnected', summary: String(error),
            }) }]));
          }
        },
      }, saved?.nativeChildren === 1 ? saved.root : resume);
      initializing = false;
      await Promise.all([...childIds].map(ensureChild));
      await Promise.all(starting.values());
    },
    async catchUp() { if (replacement) return replacement.catchUp?.(); await root.catchUp?.(); await Promise.all(starting.values()); await Promise.all([...children.values()].map((child) => child.catchUp?.())); },
    async resumePoint() {
      if (replacement) return replacement.resumePoint!();
      const point = await root.resumePoint!();
      if (!point) return null;
      const childPoints: Record<string, SessionRecordResume> = {};
      for (const [id, child] of children) {
        const value = await child.resumePoint?.();
        if (value) childPoints[id] = value;
      }
      return { data: { nativeChildren: 1, root: point, children: childPoints }, fingerprint: [point.fingerprint, ...Object.entries(childPoints).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `${id}:${value.fingerprint}`)].join('|') };
    },
    stop() { stopped = true; replacement?.stop(); root.stop(); stopChildren(); },
  };
}
