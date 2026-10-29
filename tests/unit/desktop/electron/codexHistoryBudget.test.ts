import { describe, expect, it, vi } from 'vitest';
import { replayHistoryWithinBudget } from '../../../../apps/desktop/electron/runtime/codex-app-server-history.mjs';

describe('Codex replay budget reports what is known', () => {
  it('does not report success or start replay after the load budget expires', async () => {
    const replay = vi.fn().mockResolvedValue(null);
    expect(await replayHistoryWithinBudget(100, replay, () => 100)).toMatchObject({ status: 'unknown', reason: expect.stringContaining('budget') });
    expect(replay).not.toHaveBeenCalled();
  });
  it('does not claim an incomplete page or read failure was complete', async () => {
    expect(await replayHistoryWithinBudget(100, async () => 'history replay incomplete: pages', () => 0))
      .toEqual({ status: 'unknown', reason: 'history replay incomplete: pages' });
    expect(await replayHistoryWithinBudget(100, async () => { throw new Error('read failed'); }, () => 0))
      .toEqual({ status: 'unknown', reason: 'read failed' });
  });
  it('marks a completed replay known', async () => {
    expect(await replayHistoryWithinBudget(100, async () => null, () => 0)).toEqual({ status: 'known' });
  });
});
