import { describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => ({ calls: [] as unknown[], tabs: 0, views: [] as string[] }));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => {
  const paneLayout = {
    get groups() {
      return [{ pane: { tabOrder: Array.from({ length: opened.tabs }, (_, i) => `t${i}`) } }];
    },
    open: (...args: unknown[]) => opened.calls.push(args),
  };
  return {
    asProvisioned: (page: unknown) => page,
    getSessionPageStore: () => ({}),
    getSessionView: (projectId: string, sessionId: string) => {
      opened.views.push(`${projectId}/${sessionId}`);
      return { paneLayout };
    },
  };
});
vi.mock('./stores/session-registry', () => ({
  sessionRegistry: { get: () => ({ sessions: { get: () => ({ data: { runtime: 'pty' } }) } }) },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (k: string) => k }));

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

  it('群聊第二个 Agent：页签在已有右栏打开，资源仍属于目标会话', () => {
    opened.calls = [];
    opened.views = [];
    openSessionInSessionWhenReady({ projectId: 'other-project', sessionId: 'agent-2', host: { projectId: 'p', sessionId: 'agent-1' } });
    expect(opened.calls).toEqual([['session', { sessionId: 'agent-2', projectId: 'other-project', ownerSessionId: 'agent-2' }, { preview: false }]]);
    expect(opened.views).toEqual(['p/agent-1', 'p/agent-1']);
  });
});
