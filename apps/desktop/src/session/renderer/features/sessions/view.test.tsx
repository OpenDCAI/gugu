import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const provisionSession = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mountProject = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const state = vi.hoisted(() => ({
  kind: 'idle',
  machine: null as string | null,
  link: 'closed',
  listeners: new Set<() => void>(),
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: () => ({}),
  sessionViewKind: () => state.kind,
  getSessionManagerStore: () => ({ provisionSession }),
}));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ mountProject }) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => state.machine } }));
vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: () => state.link,
  onMachineReconnected: (_machine: string, cb: () => void) => {
    let open = state.link === 'open';
    const listener = () => {
      if (state.link === 'open' && !open) cb();
      open = state.link === 'open';
    };
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
const setLink = (link: string) => {
  state.link = link;
  for (const listener of [...state.listeners]) listener();
};
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: vi.fn() }));
vi.mock('@renderer/features/sessions/session-view-guard', () => ({ sessionViewCanActivate: () => true }));
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  SessionViewWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./commands', () => ({ createSessionCommandProvider: vi.fn() }));
vi.mock('./main-panel', () => ({ SessionMainPanel: () => null }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellTitlebar: () => null }));

const { sessionView } = await import('./view');

let root: Root;
const page = (shown: boolean) => (
  <PageShownContext.Provider value={shown}>
    <sessionView.WrapView projectId="p" sessionId="s">
      <div />
    </sessionView.WrapView>
  </PageShownContext.Provider>
);

describe('session view: an idle session is provisioned only by the page on screen', () => {
  beforeEach(() => {
    provisionSession.mockClear();
    mountProject.mockClear();
    Object.assign(state, { kind: 'idle', machine: null, link: 'closed' });
    state.listeners.clear();
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('a hidden retained page leaves a reclaimed (idle) session stopped until it is shown', () => {
    act(() => root.render(page(false)));
    expect(provisionSession).toHaveBeenCalledTimes(0);
    act(() => root.render(page(true)));
    expect(provisionSession).toHaveBeenCalledTimes(1);
  });

  it('a local session that failed to provision waits for Retry: no automatic retry', () => {
    state.kind = 'provision-error';
    act(() => root.render(page(true)));
    expect(provisionSession).toHaveBeenCalledTimes(0);
  });

  it("a session on another machine waits for that machine's link, and a failure is retried once when the link opens", () => {
    state.machine = 'mac-1';
    act(() => root.render(page(true)));
    expect(provisionSession).toHaveBeenCalledTimes(0); // idle, link down: not provisioned (it could only fail)
    act(() => setLink('open'));
    expect(provisionSession).toHaveBeenCalledTimes(1);
    // it failed (the link dropped again right after): retried once when the link comes back, not in a loop
    state.kind = 'provision-error';
    act(() => setLink('closed'));
    act(() => root.render(page(true)));
    expect(provisionSession).toHaveBeenCalledTimes(1);
    act(() => setLink('open'));
    expect(provisionSession).toHaveBeenCalledTimes(2);
    act(() => root.render(page(true)));
    expect(provisionSession).toHaveBeenCalledTimes(2);
  });

  it('a hidden retained page does not retry either when the link opens', () => {
    state.machine = 'mac-1';
    state.kind = 'provision-error';
    act(() => root.render(page(false)));
    act(() => setLink('open'));
    expect(provisionSession).toHaveBeenCalledTimes(0);
  });

  it('remounts an open task after its machine reconnects, then prepares its workspace without a manual retry', () => {
    state.machine = 'mac-1';
    state.kind = 'project-error';
    act(() => root.render(page(true)));
    expect(mountProject).not.toHaveBeenCalled();
    act(() => setLink('open'));
    expect(mountProject).toHaveBeenCalledExactlyOnceWith('p');
    state.kind = 'idle';
    act(() => root.render(page(true)));
    expect(provisionSession).toHaveBeenCalledExactlyOnceWith('s');
  });

  it('retries a late project failure once per reconnection, never in an error loop', () => {
    state.machine = 'mac-1';
    state.kind = 'project-mounting';
    act(() => root.render(page(true)));
    act(() => setLink('open'));
    state.kind = 'project-error';
    act(() => root.render(page(true)));
    expect(mountProject).toHaveBeenCalledTimes(1);
    state.kind = 'project-mounting';
    act(() => root.render(page(true)));
    state.kind = 'project-error';
    act(() => root.render(page(true)));
    expect(mountProject).toHaveBeenCalledTimes(1);
    act(() => setLink('closed'));
    act(() => setLink('open'));
    expect(mountProject).toHaveBeenCalledTimes(2);
  });

  it('leaves hidden retained tasks alone until shown', () => {
    state.machine = 'mac-1';
    state.kind = 'project-error';
    act(() => root.render(page(false)));
    act(() => setLink('open'));
    expect(mountProject).not.toHaveBeenCalled();
    act(() => root.render(page(true)));
    expect(mountProject).toHaveBeenCalledTimes(1);
  });

  it('does not automatically remount an unrelated local or continuously online project failure', () => {
    state.kind = 'project-error';
    act(() => root.render(page(true)));
    state.machine = 'mac-1'; state.link = 'open';
    act(() => root.render(page(true)));
    expect(mountProject).not.toHaveBeenCalled();
  });
});
