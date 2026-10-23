import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@gugu/session-core/acp';
import type { ActivityEvent } from '@shared/core/activity';
import { onActivitySignal } from './signals';
import { SessionActivityObserver } from './session-observation';

let observer: SessionActivityObserver;
let events: Omit<ActivityEvent, 'observed_at'>[];
let off: () => void;
const summary = (lifecycle: SessionSummary['lifecycle'], modelId: string | null): SessionSummary => ({
  sessionId: 's1', projectId: 'p1', lifecycle, modelId, title: 'PRIVATE TITLE',
} as SessionSummary);
beforeEach(() => {
  observer = new SessionActivityObserver(); events = [];
  off = onActivitySignal(event => events.push(event));
});
afterEach(() => { off(); observer.dispose(); });

describe('activity from existing session metadata', () => {
  it('treats the first model as a baseline and ignores repeated snapshots and work transitions', () => {
    const a = summary('ready', 'model-a');
    observer.observe(undefined, a);
    for (let n = 0; n < 200; n++) observer.observe(a, { ...a, title: `PRIVATE TITLE ${n}` });
    const working = summary('working', 'model-a');
    observer.observe(a, working); observer.observe(working, a);
    expect(events).toEqual([]);
    observer.observe(a, summary('ready', 'model-b'));
    observer.observe(summary('ready', 'model-b'), summary('ready', 'model-b'));
    expect(events).toMatchObject([{ kind: 'session.model_changed', previous_model_id: 'model-a', model_id: 'model-b', occurred_at: null }]);
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
  });
  it('ignores provisional startup catalogs and reports actual lifecycle boundaries separately', () => {
    const starting = summary('starting', 'temporary-default');
    const ready = summary('ready', 'confirmed-model');
    observer.observe(undefined, starting); observer.observe(starting, ready);
    observer.observe(ready, summary('closed', 'confirmed-model'));
    expect(events.map(e => [e.kind, e.lifecycle])).toEqual([
      ['session.lifecycle', 'ready'], ['session.lifecycle', 'closed'],
    ]);
    expect(events.some(e => e.kind === 'session.model_changed')).toBe(false);
  });
  it('keeps the last observed model over unavailable metadata, and forgets removed sessions', () => {
    const a = summary('ready', 'a'); observer.observe(undefined, a);
    observer.observe(a, summary('starting', null));
    observer.observe(summary('starting', null), summary('ready', 'b'));
    expect(events.filter(e => e.kind === 'session.model_changed')).toMatchObject([{ previous_model_id: 'a', model_id: 'b' }]);
    observer.forget('s1'); events.length = 0;
    observer.observe(undefined, summary('ready', 'c'));
    expect(events).toEqual([]);
  });
});
