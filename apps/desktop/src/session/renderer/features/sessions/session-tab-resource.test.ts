import { describe, expect, it, vi } from 'vitest';
import { observable, runInAction } from 'mobx';
import type { PageSessionsStore, SessionStore } from './page-sessions-store';

let registry: ReturnType<typeof observable.box<PageSessionsStore | undefined>>;
vi.mock('./stores/session-registry', () => ({
  sessionRegistry: { get: () => registry.get() },
}));
import { SessionTabResource } from './session-tab-resource';

function harness() {
  registry = observable.box<PageSessionsStore | undefined>(undefined, { deep: false });
  const close = vi.fn().mockResolvedValue(true);
  const resource = new SessionTabResource('conversation', {
    tabId: 'tab', close, open: vi.fn(), pin: vi.fn(),
  });
  const list = observable({ data: null as unknown[] | null, loading: true, error: undefined as string | undefined, load: vi.fn() }, { load: false });
  const sessions = observable.map<string, SessionStore>(undefined, { deep: false });
  const manager = { list, sessions } as unknown as PageSessionsStore;
  return { resource, close, list, sessions, manager };
}

describe('conversation tab follows real registry readiness', () => {
  it('keeps the same tab through an arbitrarily late registry and list response', async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.close).not.toHaveBeenCalled();
      runInAction(() => registry.set(h.manager));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.close).not.toHaveBeenCalled();
      const store = { data: { id: 'conversation' }, seen: false, markSeen: vi.fn() } as unknown as SessionStore;
      runInAction(() => {
        h.sessions.set('conversation', store);
        h.list.data = [{}];
        h.list.loading = false;
      });
      expect(h.resource.store).toBe(store);
      h.resource.onActivate();
      expect(store.markSeen).toHaveBeenCalledOnce();
      expect(h.close).not.toHaveBeenCalled();
    } finally { h.resource.dispose(); vi.useRealTimers(); }
  });

  it('shows the actual list error with retry, and closes only after a successful absent result', async () => {
    const h = harness();
    try {
      runInAction(() => {
        registry.set(h.manager);
        h.list.loading = false;
        h.list.error = 'list request failed';
      });
      expect(h.resource.loadFailure?.message).toBe('list request failed');
      expect(h.close).not.toHaveBeenCalled();
      h.resource.retryLoad();
      expect(h.list.load).toHaveBeenCalledOnce();
      runInAction(() => {
        h.list.error = undefined;
        h.list.data = [];
      });
      await Promise.resolve();
      expect(h.close).toHaveBeenCalledOnce();
    } finally { h.resource.dispose(); }
  });

  it('does not reopen or close anything after its resource is disposed', async () => {
    const h = harness();
    h.resource.dispose();
    runInAction(() => {
      registry.set(h.manager);
      h.list.loading = false;
      h.list.data = [];
    });
    await Promise.resolve();
    expect(h.close).not.toHaveBeenCalled();
  });
});
