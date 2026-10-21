import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from './acp-chat-store';

const mocks = vi.hoisted(() => ({
  markSeen: vi.fn(),
  renameSession: vi.fn(),
}));

vi.mock('../stores/session-registry', () => ({
  sessionRegistry: {
    get: () => ({
      sessions: new Map([
        ['source-conversation', { seen: false, markSeen: mocks.markSeen }],
      ]),
      renameSession: mocks.renameSession,
    }),
  },
}));

import { AcpChatTabResource } from './acp-chat-tab-resource';

function fakeStore(isTransient: boolean): AcpChatStore {
  return {
    sessionId: 'source-conversation',
    isTransient,
    bootstrap: vi.fn(),
  } as unknown as AcpChatStore;
}

describe('AcpChatTabResource runtime-only side chat', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bootstraps without marking or renaming the persisted source conversation', () => {
    const store = fakeStore(true);
    const resource = new AcpChatTabResource(store);

    resource.onActivate();
    resource.rename('should-not-persist');

    expect(store.bootstrap).toHaveBeenCalledTimes(1);
    expect(mocks.markSeen).not.toHaveBeenCalled();
    expect(mocks.renameSession).not.toHaveBeenCalled();
  });

  it('preserves ordinary persisted conversation activation behavior', () => {
    const store = fakeStore(false);
    const resource = new AcpChatTabResource(store);

    resource.onActivate();
    resource.rename('persisted-title');

    expect(mocks.markSeen).toHaveBeenCalledTimes(1);
    expect(mocks.renameSession).toHaveBeenCalledWith(
      'source-conversation',
      'persisted-title'
    );
  });
});
