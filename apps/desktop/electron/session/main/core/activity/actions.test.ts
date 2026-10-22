import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ journal: { list: vi.fn(), get: vi.fn() }, recordHistoryPage: vi.fn() }));
vi.mock('./collector', () => ({ activityJournal: () => mocks.journal }));
vi.mock('@main/core/session-timeline/service', () => ({ recordHistoryPage: mocks.recordHistoryPage }));
import { runActivityAction } from './actions';
beforeEach(() => vi.clearAllMocks());

describe('activity metadata and on-demand context have separate read paths', () => {
  it('metadata query never opens the original record', async () => {
    mocks.journal.list.mockReturnValue({ events: [], coverage: { scope: 'this_machine' } });
    await runActivityAction({ action: 'activity_list', since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z' });
    expect(mocks.journal.list).toHaveBeenCalledOnce();
    expect(mocks.recordHistoryPage).not.toHaveBeenCalled();
  });
  it('on demand returns original input and latest reply, without tools or thinking', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e1', session_id: 's1' });
    mocks.recordHistoryPage.mockResolvedValue({ ok: true, value: { hasOlder: true, turns: [{ id: 't1', seq: 1, items: [
      { id: 'i1', kind: 'message', role: 'user', text: 'Please check the task' },
      { id: 'i2', kind: 'thinking', text: 'internal thought' },
      { id: 'i3', kind: 'execute-tool-call', output: 'private process output' },
      { id: 'i4', kind: 'message', role: 'assistant', text: 'I sent a reminder' },
    ] }] } });
    const result = await runActivityAction({ action: 'activity_context', event_id: 'e1' });
    expect(mocks.recordHistoryPage).toHaveBeenCalledWith({ conversationId: 's1', limit: 4 });
    expect(result).toMatchObject({ context_available: true, event_anchored: false, has_older: true, next_before_seq: 1,
      context: [{ inputs: [{ text: 'Please check the task' }], latest_reply: { text: 'I sent a reminder' } }] });
    expect(JSON.stringify(result)).not.toMatch(/internal thought|private process output/);
  });
  it('reports a missing original record without claiming an empty context', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e2', session_id: 'deleted' });
    mocks.recordHistoryPage.mockResolvedValue({ ok: false, error: { code: 'session_not_found' } });
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e2' })).toMatchObject({ context_available: false, reason: { code: 'session_not_found' } });
  });
  it('uses the source turn ID instead of returning a later unrelated task, and supports older pages', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e3', session_id: 's1', turn_id: 'original-turn' });
    mocks.recordHistoryPage.mockResolvedValue({ ok: true, value: { turns: [], hasOlder: false } });
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e3' })).toMatchObject({ scope: 'event_turn', event_anchored: true });
    expect(mocks.recordHistoryPage).toHaveBeenLastCalledWith({ conversationId: 's1', limit: 4, atTurnId: 'original-turn' });
    await runActivityAction({ action: 'activity_context', event_id: 'e3', before_seq: 10 });
    expect(mocks.recordHistoryPage).toHaveBeenLastCalledWith({ conversationId: 's1', limit: 4, beforeSeq: 10 });
    mocks.recordHistoryPage.mockResolvedValue({ ok: true, value: 'no-such-turn' });
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e3' })).toMatchObject({ context_available: false, reason: 'no-such-turn' });
  });
});
