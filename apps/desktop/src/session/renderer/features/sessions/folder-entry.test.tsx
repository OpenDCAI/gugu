// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Folder } from '@/lib/icons';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  open: vi.fn(), chatOpen: vi.fn(), appOpen: vi.fn(), navigate: vi.fn(), command: undefined as undefined | (() => void),
  folderEnabled: true,
  chats: [{ id: 'dm', kind: 'dm' }, { id: 'group', kind: 'group' }],
  tabs: [
    { kind: 'workspace.main', extensionId: 'workspace', title: 'Folder', iconDataUrl: 'data:image/png;base64,folder' },
    { kind: 'notes.main', extensionId: 'notes', title: 'Notes', iconDataUrl: null },
  ],
}));

vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  WORKSPACE_APP_ID: 'workspace',
  installedExtensionsStore: {
    get enabledTabContributions() { return h.tabs.filter((tab) => h.folderEnabled || tab.extensionId !== 'workspace'); },
    get allTabContributions() { return h.tabs; },
    openableApps: [{ extensionId: 'notes', name: 'Notes', kind: 'notes.main', iconDataUrl: null }],
    tabTitle: (kind: string) => h.tabs.find((tab) => tab.kind === kind)?.title,
  },
}));
vi.mock('@renderer/app/screen-block-context', () => ({ useScreenBlock: () => ({ blockId: null }) }));
vi.mock('@renderer/features/tabs/pane-context', () => ({ usePaneContext: () => ({ pane: { open: h.open }, paneId: 'pane', isFocusedPane: true }) }));
vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useSessionViewContext: () => ({ projectId: 'project', sessionId: 'task' }),
  useWorkspaceViewModel: () => ({ paneLayout: { open: h.open }, openTerminalAsTab: vi.fn() }),
}));
vi.mock('@renderer/features/sessions/start-side-session', () => ({ canStartSideSession: () => true, startSideSession: vi.fn() }));
vi.mock('@renderer/features/sessions/pane-empty-state', () => ({
  getSessionWorkspaceActionOrder: () => ['side-session', 'review', 'terminal', 'browser', 'ports'],
  sessionWorkspaceActionBlocked: () => null, workspaceBlockedTitle: () => undefined,
}));
vi.mock('@renderer/features/settings/use-terminal-enabled', () => ({ useTerminalEnabled: () => true }));
vi.mock('@renderer/lib/stores/use-agents', () => ({ useAgents: () => ({ data: [] }) }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: h.navigate }) }));
vi.mock('@renderer/lib/commands/use-command-provider', () => ({
  useCommandProvider: ({ getCommands }: { getCommands: () => { execute: () => void }[] }) => { h.command = getCommands()[0]?.execute; },
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({
  translate: (key: string) => ({ 'workspace.sideTask': 'Side chat', 'workspace.review': 'Review', 'workspace.terminal': 'Terminal', 'workspace.browser': 'Browser', 'remotePorts.tool': 'Ports', 'extensions.appsSection': 'Apps', 'extensions.addAction': 'Add App', 'task.addPanel': 'Add panel' } as Record<string, string>)[key] ?? key,
}) }));
vi.mock('react-i18next', async (importOriginal) => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => ({ 'header.folder': 'Folder', 'header.groupFolder': 'Group folder' } as Record<string, string>)[key] ?? key }) }));
vi.mock('@/store/chatContext', () => ({ useChatStore: () => ({ chats: h.chats }) }));
vi.mock('@/lib/chatSummariesBridge', () => ({
  readChatSummary: (id: string) => h.chats.find((chat) => chat.id === id), subscribeChatSummaries: () => () => {},
}));
vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({ openPanelItem: h.chatOpen }));
vi.mock('@/components/appSlot/useOpenApp', () => ({ openApp: h.appOpen }));
// Keep the menu's actual task/chat builders and event wiring; only replace the portal/menu primitive.
vi.mock('@renderer/lib/ui/dropdown-menu', async () => {
  const { createContext, useContext } = await import('react');
  const Context = createContext({ open: false, change: (_open: boolean) => {} });
  return {
    DropdownMenu: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => <Context.Provider value={{ open, change: onOpenChange }}>{children}</Context.Provider>,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => { const c = useContext(Context); return <button data-trigger onClick={() => c.change(!c.open)}>{children}</button>; },
    DropdownMenuContent: ({ children }: { children: ReactNode }) => useContext(Context).open ? <div role="menu">{children}</div> : null,
    DropdownMenuGroup: ({ children }: { children: ReactNode }) => <section data-apps>{children}</section>,
    DropdownMenuLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    DropdownMenuItem: ({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => <button role="menuitem" disabled={disabled} onClick={onClick}>{children}</button>,
  };
});
vi.mock('@renderer/lib/ui/shortcut', () => ({ BoundShortcut: () => null }));
vi.mock('@renderer/features/extensions/extension-commands', () => ({ declaredMenuCommands: () => [], runExtensionCommand: vi.fn() }));
vi.mock('@renderer/features/extensions/extension-tab-pane', () => ({ ExtensionTabPane: () => null }));
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({ ExtensionSharedSlot: () => null }));
vi.mock('@renderer/app/screen-layout-actions', () => ({ placeOnScreen: vi.fn(), takeAppOffScreen: vi.fn() }));
vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({ openFileInBuiltInEditor: vi.fn() }));
vi.mock('@renderer/features/extensions/extension-surface-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../extensions/extension-surface-store')>(),
  extensionSurfaceStore: { state: () => ({ error: null, badge: null }), sharedState: () => ({ title: null, error: null, badge: null }), said: () => ({ title: null, error: null, badge: null }) },
}));
vi.mock('@/lib/fileHost', () => ({ useFileHost: () => null, openFileStorageSettings: vi.fn() }));
vi.mock('@renderer/features/tabs/tab-bar/generic-tab-item', () => ({
  GenericTabItem: ({ label, preSlot }: { label: string; preSlot: ReactNode }) => <div data-tab>{preSlot}<span>{label}</span></div>,
  GenericTabDragPreview: () => null,
}));

const { TabBarAddMenu } = await import('./tab-bar-actions');
const { createExtensionTabProvider, ExtensionTabResource } = await import('../extensions/extension-tab-provider');
const { chatPanelTabProvider, ChatTabResource } = await import('../chats/chat-tabs/chat-tab-providers');

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  h.folderEnabled = true; h.command = undefined; vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

async function menu(chatId?: string, shortcut = false) {
  await act(async () => root.render(<TabBarAddMenu chatId={chatId} />));
  await act(async () => { if (shortcut) h.command!(); else container.querySelector<HTMLButtonElement>('[data-trigger]')!.click(); });
  return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}
const text = (item: Element) => item.textContent?.trim();
const glyph = (item: Element) => item.querySelector('svg')?.innerHTML;

describe('folder entry E1-E3', () => {
  it('E1 / CmdT: puts Folder first, where a chat\'s + puts its folder, and keeps its original open target', async () => {
    const groupGlyph = glyph((await menu('group'))[0]!);
    const items = await menu(undefined, true);
    expect(items.filter((item) => !item.closest('[data-apps]')).map(text)).toEqual(['Folder', 'Side chat', 'Review', 'Terminal', 'Browser', 'Ports']);
    expect(glyph(items[0]!)).toBe(groupGlyph);
    await act(async () => items[0]!.click());
    expect(h.open).toHaveBeenCalledWith('workspace.main', {}, { from: null, intent: 'newTab', target: { paneId: 'pane' } });
  });
  it('E1: the task Apps section omits only the folder and keeps other Apps', async () => {
    await menu();
    expect([...container.querySelectorAll('[data-apps] [role="menuitem"]')].map(text)).toEqual(['Notes', 'Add App…']);
  });
  it.each(['dm', 'group'])('E2: %s offers its own named folder first and opens that chat', async (chatId) => {
    const items = await menu(chatId);
    expect(text(items[0]!)).toBe(chatId === 'group' ? 'Group folder' : 'Folder');
    expect(glyph(items[0]!)).toBe(new DOMParser().parseFromString(renderToStaticMarkup(<Folder />), 'text/html').querySelector('svg')?.innerHTML);
    await act(async () => items[0]!.click());
    expect(h.chatOpen).toHaveBeenCalledWith(chatId, { kind: 'workspace.main', title: '' });
  });
  it.each(['task', 'dm', 'group'])('E3: %s tab matches its menu label and Folder glyph', async (place) => {
    const items = await menu(place === 'task' ? undefined : place);
    const item = items.find((row) => text(row) === (place === 'group' ? 'Group folder' : 'Folder'))!;
    const label = text(item);
    const provider = place === 'task' ? createExtensionTabProvider('workspace', 'main') : chatPanelTabProvider;
    const entry = { tabId: 'folder', kind: place === 'task' ? 'workspace.main' : 'chat-panel', isPreview: false, state: { kind: 'workspace.main', title: '' } };
    const resource = place === 'task' ? new ExtensionTabResource('workspace') : new ChatTabResource(entry);
    const tab = { ...entry, resource, isActive: true };
    const Tab = provider.TabBarItem!;
    await act(async () => root.render(React.createElement(Tab as unknown as React.ComponentType<Record<string, unknown>>, { tab, host: { resolvedTabs: [tab] }, ctx: { place: place === 'task' ? { kind: 'session', projectId: 'project', sessionId: 'task' } : { kind: 'chat', chatId: place } } })));
    const chip = container.querySelector('[data-tab]')!;
    expect(chip.textContent).toBe(label);
    expect(glyph(chip)).toBe(new DOMParser().parseFromString(renderToStaticMarkup(<Folder />), 'text/html').querySelector('svg')?.innerHTML);
    expect(chip.querySelector('img')).toBeNull();
  });
  it('control: a task does not resurrect an unavailable/disabled folder contribution', async () => {
    h.folderEnabled = false;
    expect((await menu()).map(text)).not.toContain('Folder');
  });
  it('control: other task Apps keep their original opening route', async () => {
    const items = await menu();
    await act(async () => items.find((item) => text(item) === 'Notes')!.click());
    expect(h.open).toHaveBeenCalledWith('notes.main', {}, { from: null, intent: 'newTab', target: { paneId: 'pane' } });
  });
});
