// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_EVENTS } from '@/lib/uiEvents';
import { APP_OPEN_WITH_EVENT } from '@shared/extensions/app-runtime-protocol';
import type { PanelItem } from '@renderer/features/chats/chat-tabs/chat-panel-item';

const { tabs, showChatTab, replacePanelItem } = vi.hoisted(() => ({
  tabs: [] as { tabId: string; inWindow: boolean; item: PanelItem }[], showChatTab: vi.fn(), replacePanelItem: vi.fn(),
}));
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ panelTabsOf: () => tabs, showChatTab, replacePanelItem }));

const navigate = vi.fn();
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ projects: new Map() }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({
  AcpChatTabResource: class {},
}));
vi.mock('./extension-surface-store', () => ({
  extensionSurfaceStore: { say: vi.fn() },
}));

const { applyExtensionHostAction } = await import('./host-action-handlers');
beforeEach(() => { vi.clearAllMocks(); tabs.length = 0; });
afterEach(() => vi.unstubAllGlobals());

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
  const origin = { extensionId: 'workspace', sessionId: null, tabId: 'folder' };
  it('activates the existing file, then acknowledges presentation without resolving its link again', async () => {
    tabs.push({ tabId: 'held', inWindow: false, item: { kind: 'workspace.main', itemId: 'file', title: 'old' } });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 1; });
    expect(await applyExtensionHostAction({ origin, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main' } })).toEqual({ chat: 'chat' });
    expect(showChatTab).toHaveBeenCalledWith('chat', 'held');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not create or navigate to a file whose retained native page has no open tab', async () => {
    expect(await applyExtensionHostAction({ origin, action: { kind: 'openChatFile', chatId: 'chat', itemId: 'file', onlyIfOpen: 'workspace.main' } })).toBeUndefined();
    expect(showChatTab).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('refreshes only the existing tab without activating a late result or bringing its chat up', async () => {
    tabs.push({ tabId: 'held', inWindow: false, item: { kind: 'workspace.main', itemId: 'file', title: 'old' } });
    const dispatched = vi.fn();
    window.addEventListener(APP_OPEN_WITH_EVENT, dispatched);
    try {
      await applyExtensionHostAction({ origin, action: { kind: 'openWith', detail: {
        background: 'workspace.main', chatId: 'chat', itemId: 'file', name: 'renamed.md', typedName: 'renamed.md',
        file: { document: true, contentType: 'text/markdown', version: 2, size: 5 },
        choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: 'Files', app: { name: 'Files' }, onlyTab: true, suffix: '.md' } },
      } } });
      expect(replacePanelItem).toHaveBeenCalledWith('chat', 'held', { kind: 'workspace.main', itemId: 'file', title: 'renamed', fileName: 'renamed.md', typedName: 'renamed.md' });
      expect(showChatTab).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
      expect(dispatched).not.toHaveBeenCalled();
    } finally { window.removeEventListener(APP_OPEN_WITH_EVENT, dispatched); }
  });
});
