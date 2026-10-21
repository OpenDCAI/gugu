import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from './acp-chat-store';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  store: {
    sessionId: 'source-conversation',
    isTransient: true,
    runtimeView: {
      id: 'side-chat:view-1',
      forkFromProviderSessionId: 'source-session',
      forkedFromSessionId: 'source-conversation',
    },
    bootstrap: vi.fn()
  } as unknown as AcpChatStore,
}));

vi.mock('./acp-chat-resources', () => ({
  acpChatResources: () => ({ acquire: mocks.acquire, release: mocks.release })
}));
vi.mock('./acp-chat-panel', () => ({ AcpChatPanel: () => null }));
vi.mock('../stores/session-registry', () => ({
  sessionRegistry: { get: () => undefined }
}));

import { CHAT_TAB_KINDS } from '../view/session-pane-policy';
import { sideChatTabProvider, type SideChatState } from './side-chat-tab-provider';

const state: SideChatState = {
  sessionId: 'source-conversation',
  runtimeView: {
    id: 'side-chat:view-1',
    forkFromProviderSessionId: 'source-session',
    forkedFromSessionId: 'source-conversation',
  },
};

describe('side-chat workspace tab provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquire.mockReturnValue(mocks.store);
  });

  it('is an independent runtime-only workspace kind', () => {
    expect(sideChatTabProvider.kind).toBe('side-chat');
    expect(CHAT_TAB_KINDS.has(sideChatTabProvider.kind)).toBe(false);
    expect(sideChatTabProvider.resourceKey(state)).toBe('side-chat:view-1');
    expect(sideChatTabProvider.isPersistent?.(state)).toBe(false);
  });

  it('acquires by source + runtime view and releases the fork on close', () => {
    const entry = { kind: 'side-chat', tabId: 'tab-1', isPreview: false, state } as const;
    const ctx = {
      viewId: 'task-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      modelRootPath: 'workspace:workspace-1',
    };
    const resource = sideChatTabProvider.initialize(entry, {} as never, ctx);

    expect(mocks.acquire).toHaveBeenCalledWith('source-conversation', state.runtimeView);
    expect(resource.store).toBe(mocks.store);

    sideChatTabProvider.dispose(entry, resource, ctx);
    expect(mocks.release).toHaveBeenCalledWith('side-chat:view-1');
  });
});
