import { describe, expect, it, vi } from 'vitest';

/**
 * The theme an App page loads in, answered synchronously to its preload (EXTENSION_THEME_CHANNEL) so its first paint is
 * in gugu's theme: what its context says — the host's theme, even before the page is bound (it is loading), and the
 * check's own where `app_check` shows its page in a theme of its own.
 */

const PAGE = 7;
const CHECK = 9;
const UNBOUND = 11;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: null, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const syncHandlers = new Map<string, (event: { sender: { id: number }; returnValue?: unknown }) => void>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, fn: (event: { sender: { id: number }; returnValue?: unknown }) => void) => syncHandlers.set(channel, fn),
  },
  clipboard: { writeText: vi.fn() },
  shell: {},
  webContents: { fromId: (id: number) => ([PAGE, CHECK].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'board', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => [], hasCapability: () => true, get: () => ({ manifest: { name: 'Board' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost, showAgentPageInTheme } = await import('./extension-bridge');
const { EXTENSION_THEME_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
setExtensionBridgeHost({
  deliver: async () => undefined,
  presentation: () => ({ locale: 'zh-CN', themeMode: 'light', fullscreen: false, windowFocused: true }),
});

const themeAsked = (sender: number): unknown => {
  const event: { sender: { id: number }; returnValue?: unknown } = { sender: { id: sender } };
  syncHandlers.get(EXTENSION_THEME_CHANNEL)!(event);
  return event.returnValue;
};

describe('the theme a page loads in (its first paint)', () => {
  it('is the host\'s, before the page is bound and after', async () => {
    expect(themeAsked(UNBOUND)).toBe('light');
    await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'board', tabId: 'slot', tabKind: 'board.main' });
    expect(themeAsked(PAGE)).toBe('light');
  });

  it('is the check\'s own where app_check shows its page in a theme of its own', async () => {
    await bindExtensionSurface({ webContentsId: CHECK, extensionId: 'board', tabId: 'extension-check:9', tabKind: 'board.main', operator: { kind: 'agent', id: 'user:agent-f' } });
    showAgentPageInTheme(CHECK, 'dark');
    expect(themeAsked(CHECK)).toBe('dark');
    expect(themeAsked(PAGE)).toBe('light');
  });
});
