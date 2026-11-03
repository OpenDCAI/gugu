// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_EVENTS } from '@/lib/uiEvents';
import { APP_OPEN_WITH_EVENT } from '@shared/extensions/app-runtime-protocol';
import { groupPageSlot, type PanelItem } from '@renderer/features/chats/chat-tabs/chat-panel-item';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';

const { tabs, showChatTab, updateFileNames, projects } = vi.hoisted(() => ({
  projects: new Map(),
  tabs: [] as { tabId: string; inWindow: boolean; shown?: boolean; item: PanelItem }[], showChatTab: vi.fn(), updateFileNames: vi.fn(), }));
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ panelTabsOf: () => tabs, showChatTab, updateFileNames, chatLayoutOf: () => ({ groups: [{ pane: { entries: new Map(tabs.map((tab) => [tab.tabId, tab])) } }] }) }));

const navigate = vi.fn();
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({
  AcpChatTabResource: class {},
}));
vi.mock('./extension-surface-store', () => ({
  extensionSurfaceStore: { say: vi.fn() },
}));

const { WorkspaceViewModel } = await import('@renderer/features/sessions/stores/workspace-view-model');
const { applyExtensionHostAction } = await import('./host-action-handlers');
beforeEach(() => { vi.clearAllMocks(); tabs.length = 0; projects.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('an App browser open keeps the host-stamped source', () => {
  it('navigates the originating context after focus moves to another pane', async () => {
    const provider = (kind: string) => createTabProvider({
      kind, resourceKey: (state: { initialUrl: string }) => state.initialUrl,
      initialize: () => ({ dispose() {} }), dispose() {},
      TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null,
    });
    const layout = new PaneLayoutStore(createTabRegistry([provider('app'), provider('browser')]), { viewId: 'app-origin' });
    try {
      layout.open('app', { initialUrl: 'app-a' }, { from: null, intent: 'newTab' });
      const source = layout.focusedPane;
      const tabId = source.resolvedActiveTabId!;
      layout.open('app', { initialUrl: 'app-b' }, { from: tabId, intent: 'beside' });
      const other = layout.focusedPane;
      const otherBefore = JSON.parse(JSON.stringify(other.snapshot));
      expect(other).not.toBe(source);
      const view = {
        paneLayout: layout, get activePane() { return layout.focusedPane; },
        showPage: WorkspaceViewModel.prototype.showPage, setFocusedRegion: vi.fn(),
      };
      projects.set('project', { mountedProject: { sessionManager: { sessions: new Map([['task', { viewModel: view }]]) } } });
      // The bridge delivers the original page identity after the person has focused B.
      await Promise.resolve();
      await applyExtensionHostAction({ origin: { extensionId: 'app', sessionId: 'task', tabId }, action: { kind: 'openBrowserTab', url: 'https://example.com/from-a' } });
      expect(source.entries.get(tabId)).toMatchObject({ kind: 'browser', state: { initialUrl: 'https://example.com/from-a' } });
      expect(source.navigationOf(tabId)?.pages).toHaveLength(2);
      expect(other.snapshot).toEqual(otherBefore);
    } finally { layout.dispose(); }
  });

  it('preserves the no-session shell refusal', () => {
    expect(() => applyExtensionHostAction({ origin: { extensionId: 'app', sessionId: null, tabId: 'shell' }, action: { kind: 'openBrowserTab', url: 'https://example.com/' } })).toThrow('This session is no longer open');
  });
});

/**
 * R A/B 10-06: a banner's or a link's click that names no place opens the App's own page, which lives on the task
 * surface — from the chats page it opened unseen, the shell stayed on chats. Control (0a436892f1): no reveal asked.
 */
describe("a click that opens the App's own page brings the task page forward", () => {
  it('navigates to the App and asks the shell to show the task page', () => {
    const revealed = vi.fn();
    window.addEventListener(UI_EVENTS.sessionpageReveal, revealed);
    try {
      applyExtensionHostAction({ origin: null, action: { kind: 'openApp', extensionId: 'board' } } as never);
      expect(navigate).toHaveBeenCalledWith('app', { appId: 'board' });
      expect(revealed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(UI_EVENTS.sessionpageReveal, revealed);
    }
  });
});

describe('showing an already-open file while its metadata is checked', () => {
  const origin = { extensionId: 'workspace', sessionId: null, tabId: groupPageSlot('chat', 'folder') };
  beforeEach(() => { tabs.push({ tabId: 'folder', inWindow: false, shown: true, item: { kind: 'workspace.main', title: 'Group folder' } }); });
  it('activates the existing file in a background window without resolving its link again', async () => {
    tabs[0]!.item = { kind: 'workspace.main', itemId: 'file', title: 'old' };
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    expect(await applyExtensionHostAction({ origin, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main' } })).toEqual({ chat: 'chat' });
    expect(showChatTab).toHaveBeenCalledWith('chat', 'folder');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not create or navigate to a file whose retained native page has no open tab', async () => {
    expect(await applyExtensionHostAction({ origin, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main' } })).toBeUndefined();
    expect(showChatTab).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not reuse another context or an explicit new tab during the metadata check', async () => {
    tabs.push({ tabId: 'held', inWindow: false, item: { kind: 'workspace.main', itemId: 'file', title: 'file.md' } });
    for (const intent of ['navigate', 'newTab', 'beside'] as const) {
      await expect(applyExtensionHostAction({ origin, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main', intent } })).resolves.toBeUndefined();
    }
    expect(showChatTab).not.toHaveBeenCalled();
  });

  it('leaves a file in another chat to the ordinary opener that brings its chat up', async () => {
    tabs.push({ tabId: 'held', inWindow: false, item: { kind: 'workspace.main', itemId: 'file', title: 'old' } });
    expect(await applyExtensionHostAction({ origin: { ...origin, tabId: groupPageSlot('other-chat', 'folder') }, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main' } })).toBeUndefined();
    expect(showChatTab).not.toHaveBeenCalled();
  });

  it('does not reuse an originating tab that is no longer shown', async () => {
    tabs[0]!.shown = false;
    tabs.push({ tabId: 'held', inWindow: false, item: { kind: 'workspace.main', itemId: 'file', title: 'old' } });
    expect(await applyExtensionHostAction({ origin, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main' } })).toBeUndefined();
    expect(showChatTab).not.toHaveBeenCalled();
  });

  it('refreshes only the existing tab without activating a late result or bringing its chat up', async () => {
    tabs.push({ tabId: 'held', inWindow: false, item: { kind: 'workspace.main', itemId: 'file', title: 'old' } });
    const dispatched = vi.fn();
    window.addEventListener(APP_OPEN_WITH_EVENT, dispatched);
    try {
      await applyExtensionHostAction({ origin, action: { kind: 'openWith', detail: {
        background: true, chatId: 'chat', itemId: 'file', name: 'renamed.md', typedName: 'renamed.md',
        file: { document: true, contentType: 'text/markdown', version: 2, size: 5 },
        choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: 'Files', app: { name: 'Files', defaultLocale: 'en' }, onlyTab: true, suffix: '.md', state: false } },
      } } });
      expect(updateFileNames).toHaveBeenCalledWith([{ id: 'file', filename: 'renamed.md', content_type: 'text/markdown' }], expect.any(Array));
      expect(showChatTab).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { window.removeEventListener(APP_OPEN_WITH_EVENT, dispatched); }
  });
});
