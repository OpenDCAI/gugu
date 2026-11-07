import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const store = vi.hoisted(() => ({ claim: vi.fn(() => 'token'), release: vi.fn() }));
vi.mock('./extension-view-store', () => ({ extensionViewStore: store }));
vi.mock('./extension-tab-toolbar', () => ({ ExtensionTabToolbar: () => null }));
vi.mock('@/lib/taskConversation', () => ({
  useTaskConversation: (id: string | null) => id ? 'private-chat' : null,
  useTaskProjectChat: (id: string | null) => id ? 'project-group' : null,
}));

const { ExtensionSharedSlot } = await import('./extension-shared-slot');

let root: Root;
const slot = (shown: boolean) => (
  <PageShownContext.Provider value={shown}>
    <ExtensionSharedSlot tabKind="omnisearch.settings" sessionId="s" tabId="t" />
  </PageShownContext.Provider>
);

describe('ExtensionSharedSlot: the App page goes where the page on screen asks', () => {
  beforeEach(() => {
    store.claim.mockClear();
    store.release.mockClear();
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    root = createRoot(dom.window.document.getElementById('root')!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('a hidden retained page holds no claim; shown it claims once, hidden again it releases', () => {
    act(() => root.render(slot(false)));
    expect(store.claim).toHaveBeenCalledTimes(0);
    act(() => root.render(slot(true)));
    expect(store.claim).toHaveBeenCalledTimes(1);
    act(() => root.render(slot(false)));
    expect(store.release).toHaveBeenCalledTimes(1);
  });

  it('only Files binds its task chat-file root to the project group', () => {
    act(() => root.render(<ExtensionSharedSlot tabKind="workspace.main" sessionId="s" tabId="t" />));
    expect(store.claim).toHaveBeenLastCalledWith('workspace.main', expect.objectContaining({ conversation: 'private-chat', resourceChat: 'project-group' }));
    act(() => root.render(<ExtensionSharedSlot tabKind="omnisearch.settings" sessionId="s" tabId="t" />));
    expect(store.claim).toHaveBeenLastCalledWith('omnisearch.settings', expect.objectContaining({ conversation: 'private-chat' }));
    expect(store.claim).toHaveBeenLastCalledWith('omnisearch.settings', expect.not.objectContaining({ resourceChat: 'project-group' }));
  });
});
