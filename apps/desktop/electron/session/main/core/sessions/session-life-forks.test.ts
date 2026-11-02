import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/client', () => ({ db: {} }));

import { forkStore, openRuntimeFork } from './session-life-forks';

describe('a side chat\'s in-memory queue', () => {
  it('a discard takes the row, so nothing sends it later', () => {
    openRuntimeFork({ forkId: 'fork-discard', parentId: 'parent', forkFromProviderSessionId: 'provider' });
    const kept = forkStore.enqueue({ sessionId: 'fork-discard', messageId: 'keep', text: 'keep', kind: 'ordinary' }).seq;
    const gone = forkStore.enqueue({ sessionId: 'fork-discard', messageId: 'gone', text: 'gone', kind: 'ordinary' }).seq;

    forkStore.commit('fork-discard', [{ e: 'delete-row', seq: gone }]);

    expect(forkStore.pending('fork-discard')).toEqual({ queued: [kept], dispatching: [] });
    expect(forkStore.unaccepted('fork-discard').map(row => row.message.id)).toEqual(['keep']);
  });
});
