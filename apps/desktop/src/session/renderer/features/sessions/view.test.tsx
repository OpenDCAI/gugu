import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const provisionSession = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: () => ({}),
  sessionViewKind: () => 'idle',
  getSessionManagerStore: () => ({ provisionSession }),
}));
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ leaveSessionView: vi.fn() }));
vi.mock('@renderer/features/sessions/session-view-guard', () => ({ sessionViewCanActivate: () => true }));
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  SessionViewWrapper: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./commands', () => ({ createSessionCommandProvider: vi.fn() }));
vi.mock('./main-panel', () => ({ SessionMainPanel: () => null }));
vi.mock('./session-titlebar', () => ({ SessionTitlebar: () => null }));

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
});
