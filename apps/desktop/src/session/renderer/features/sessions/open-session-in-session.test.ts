import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ calls: [] as unknown[], tabs: 0, provisioned: true, reason: null as string | null }));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => {
  const paneLayout = {
    get groups() {
      return [{ pane: { tabOrder: Array.from({ length: opened.tabs }, (_, i) => `t${i}`) } }];
    },
    open: (...args: unknown[]) => opened.calls.push(args),
  };
  return {
    asProvisioned: (page: unknown) => page,
    getSessionPageStore: () => (opened.provisioned ? {} : null),
    getSessionView: () => ({ paneLayout }),
  };
});
vi.mock('./stores/session-registry', () => ({
  sessionRegistry: { get: () => ({ sessions: { get: () => ({ data: { runtime: 'pty' } }) } }) },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (k: string) => k }));

vi.mock('./workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => opened.reason }));

import { toast } from '@renderer/lib/hooks/use-toast';
import { openSessionInSessionWhenReady } from './open-session-in-session';

describe('给屏上一块空着的会话补上对话(onlyIfNoTabs)', () => {
  it('一枚页签都没有:开它的对话', () => {
    opened.calls = [];
    opened.tabs = 0;
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    expect(opened.calls).toHaveLength(1);
  });

  it('存下的页签已经摆回来了:不动,❌ 把停在别的页签上的那一枚抢成对话', () => {
    opened.calls = [];
    opened.tabs = 2;
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's', onlyIfNoTabs: true });
    expect(opened.calls).toHaveLength(0);
  });

  it('点左边一行(不带 onlyIfNoTabs):照旧打开对话', () => {
    opened.calls = [];
    opened.tabs = 2;
    openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's' });
    expect(opened.calls).toHaveLength(1);
  });
});

describe('task entry keeps the workspace failure reason', () => {
  it.each([
    ['cloud', 'Gugu on cloud host is too old. Update Gugu there'],
    ['ssh', 'Gugu on SSH host is too old. Update Gugu there'],
    ['local', null],
  ])('%s entry uses the current reason when readiness times out', async (_route, reason) => {
    vi.useFakeTimers();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(toast).mockClear();
    opened.provisioned = false;
    opened.reason = null;
    const dispose = openSessionInSessionWhenReady({ projectId: 'p', sessionId: 's' });
    try {
      // The handshake can discover the mismatch after navigation starts.
      opened.reason = reason;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({
        description: reason ?? 'sidebar.workspaceNotReady',
      }));
    } finally {
      dispose();
      opened.provisioned = true;
      opened.reason = null;
      logged.mockRestore();
      vi.useRealTimers();
    }
  });
});
