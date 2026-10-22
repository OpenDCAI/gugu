import { JSDOM } from 'jsdom';
import { observable, runInAction } from 'mobx';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 一条会话在会话页里的那一份:ready ⇔ provisioned 且挂着工作区(闲置回收把它挂起成 unprovisioned、清掉工作区)。
const store = vi.hoisted(() => ({ current: null as null | { state: string; workspaceId: string | null; viewModel: unknown } }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: () => store.current ?? undefined,
  sessionViewKind: (s: { state: string } | undefined) => (!s ? 'missing' : s.state === 'provisioned' ? 'ready' : 'idle'),
  getSessionManagerStore: () => undefined,
  sessionErrorMessage: () => undefined,
  getPageSessions: () => undefined,
  getTerminalsForSession: () => undefined,
  getWorkspaceForSession: () => undefined,
}));
// 窗里那一格的内容换成一层「读工作区」的内容:和真页签内容(终端、文件)一样,会话没有工作区时读就抛。
vi.mock('@renderer/features/tabs/pane-content', async () => {
  const { useWorkspaceId } = await import('../session-view-context');
  return {
    PaneContent: () => <div data-testid="tab-content">{useWorkspaceId()}</div>,
  };
});
vi.mock('@renderer/features/tabs/pane-context', () => ({ PaneProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@renderer/app/aux-window-host', () => ({ auxLeadingReserve: () => 0, PutBackButton: () => null }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellTitlebarDragRegion: () => null }));
vi.mock('../titlebar-actions', () => ({ TabBarActionRow: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../view/session-main-column', () => ({ SessionMainColumn: () => null }));
vi.mock('../session-tab-registry', () => ({ sessionTabView: { TabLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> } }));
vi.mock('../use-cloud-computer-gate', () => ({ useCloudComputerGate: () => null }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: {} }));
vi.mock('@renderer/features/remote-hosts/connection-status', () => ({ cloudWakeFailureText: () => '' }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ ensureMounted: () => Promise.resolve() }) }));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: vi.fn() }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@/lib/loading/LoadingIndicator', () => ({ LoadingIndicator: ({ label }: { label: string }) => <div data-testid="loading">{label}</div> }));

const { SessionViewWrapper } = await import('../session-view-context');
const { WindowTabPane } = await import('./window-tab-pane');

let root: Root;
let dom: JSDOM;
const window = () => (
  <SessionViewWrapper projectId="p" sessionId="s">
    <WindowTabPane windowId="w1" paneId="pane-1" />
  </SessionViewWrapper>
);

describe('a tab opened in its own window, while its session leaves ready', () => {
  beforeEach(() => {
    dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    const group = { pane: { tabOrder: ['t1'], reorderTabs: vi.fn() } };
    store.current = observable(
      { state: 'provisioned', workspaceId: 'ws-1', viewModel: { paneLayout: { windowPanes: new Map([['pane-1', group]]) } } },
      { viewModel: observable.ref }
    );
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  const query = (id: string) => dom.window.document.querySelector(`[data-testid="${id}"]`);

  it('shows the not-ready screen instead of its content when idle reclaim suspends the session, and the content again once ready', () => {
    act(() => root.render(window()));
    expect(query('tab-content')?.textContent).toBe('ws-1');

    // 闲置回收(project-sessions-store 的 sessionReclaimedChannel → transitionToUnprovisioned):工作区清掉,页签还开着。
    expect(() =>
      act(() =>
        runInAction(() => {
          store.current!.workspaceId = null;
          store.current!.state = 'unprovisioned';
        })
      )
    ).not.toThrow();
    expect(query('tab-content')).toBeNull();
    expect(query('loading')?.textContent).toBe('task.settingUpWorkspace');

    act(() =>
      runInAction(() => {
        store.current!.workspaceId = 'ws-2';
        store.current!.state = 'provisioned';
      })
    );
    expect(query('loading')).toBeNull();
    expect(query('tab-content')?.textContent).toBe('ws-2');
  });
});
