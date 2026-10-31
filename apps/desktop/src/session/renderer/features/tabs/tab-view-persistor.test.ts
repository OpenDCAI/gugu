import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTabPersistor } from '@renderer/features/sessions/stores/session-tab-view-persistor';
import { rpc } from '@renderer/lib/ipc';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import type { TabGroupsSnapshot } from '@shared/view-state';
import { TabViewPersistor } from './tab-view-persistor';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { viewState: { save: vi.fn(async () => {}) } } }));

const sessionCtx = {
  viewId: 'persist-test', projectId: 'p', workspaceId: 'w', sessionId: 'persist-test',
  modelRootPath: 'workspace:w', workspacePath: '/workspace',
};
const snapshot: TabGroupsSnapshot = {
  groups: [{ groupId: 'g', tabManager: {
    tabs: [{ kind: 'file', tabId: 'f', path: 'notes.md', isPreview: false, returnTo: { tabId: 'home', message: 'm1' } }],
    activeTabId: 'f',
  } }],
  activeGroupId: 'g', paneSizes: [100],
};

afterEach(() => {
  for (const key of ['session:persist-test', 'session:persist-test:tabs', 'chat:persist-test:tabs']) viewStateCache.delete(key);
  vi.clearAllMocks();
});

describe('view-scoped tab persistence', () => {
  it.each(['session', 'chat'])('loads and registers the %s namespace without changing its snapshot', (kind) => {
    const key = `${kind}:persist-test:tabs`;
    const persistor = new TabViewPersistor(`${kind}:persist-test`);
    expect(persistor.load()).toBeNull();
    const stop = persistor.start(() => snapshot);
    expect(viewStateCache.peek(key)).toBe(snapshot);
    expect(persistor.load()).toBe(snapshot);
    expect(rpc.viewState.save).not.toHaveBeenCalled();
    stop();
    expect(viewStateCache.peek(key)).toBeUndefined();
  });

  it('does not interpret another host\'s aggregate as a task snapshot', () => {
    expect(new TabViewPersistor('chat:persist-test').load({ tabGroups: snapshot })).toBeNull();
    expect(rpc.viewState.save).not.toHaveBeenCalled();
  });

  it('retains the existing task key and normalizes file paths without changing return navigation', () => {
    viewStateCache.set('session:persist-test:tabs', snapshot);
    const loaded = createSessionTabPersistor(sessionCtx).load();
    expect(loaded?.groups[0].tabManager.tabs[0]).toEqual({
      kind: 'file', tabId: 'f', path: '/workspace/notes.md', isPreview: false,
      returnTo: { tabId: 'home', message: 'm1' },
    });
    expect(rpc.viewState.save).not.toHaveBeenCalled();
  });

  it.each([
    { tabGroups: snapshot },
    { tabManager: snapshot.groups[0].tabManager },
    { sessions: { tabOrder: ['s1'] } },
  ])('keeps the existing task aggregate migration %#', (aggregate) => {
    viewStateCache.set('session:persist-test', aggregate);
    const loaded = createSessionTabPersistor(sessionCtx).load();
    expect(loaded?.groups).toHaveLength(1);
    expect(loaded?.groups[0].tabManager.tabs).toHaveLength(1);
    expect(rpc.viewState.save).toHaveBeenCalledWith('session:persist-test:tabs', viewStateCache.peek('session:persist-test:tabs'));
  });

  it('prefers the dedicated task snapshot to a supplied legacy aggregate', () => {
    viewStateCache.set('session:persist-test:tabs', snapshot);
    const loaded = createSessionTabPersistor(sessionCtx).load({ sessions: { tabOrder: ['old'] } });
    expect(loaded?.groups[0].tabManager.activeTabId).toBe('f');
    expect(rpc.viewState.save).not.toHaveBeenCalled();
  });
});
