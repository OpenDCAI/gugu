import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F68 (L5 S16): a real page recorded F62's hint ("written 50.7 times a second") after ~9 s; asked whether the
 * platform said anything, the agent ran `app_check`, got `errors: []` and answered "the check passed". The host now
 * keeps every real page's records per App — task tabs too — each with the page it came from and when, for the check to
 * read (`recentExtensionErrors`). The check's own page is not among them.
 */

const GROUP_PAGE = 7;
const SESSION_TAB = 8;
const CHECK_PAGE = 9;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => ([GROUP_PAGE, SESSION_TAB, CHECK_PAGE].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'board',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => [],
    hasCapability: () => false,
    get: () => ({ manifest: { name: 'Board' } }),
  }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost, recentExtensionErrors, watchExtensionSurfaceErrors } =
  await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const report = (sender: number, message: string, level?: 'hint') =>
  handle({ sender: { id: sender, session: {} } }, { method: 'reportError', args: { message, ...(level ? { level } : {}) } });

const CHAT = '0b000000-0000-4000-8000-000000000068';
const ITEM = '0c000000-0000-4000-8000-000000000068';
const deliver = vi.fn(() => Promise.resolve());

beforeEach(async () => {
  deliver.mockClear();
  setExtensionBridgeHost({
    deliver,
    presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: GROUP_PAGE, extensionId: 'board', tabId: 'slot-1', tabKind: 'board.main', chatId: CHAT, itemId: ITEM });
  await bindExtensionSurface({ webContentsId: SESSION_TAB, extensionId: 'board', sessionId: 'task-1', tabId: 'tab-1', tabKind: 'board.main' });
});

describe("the App's records from its real pages (摩擦单 F68)", () => {
  it('a group page’s hint and a task tab’s error are both kept, each with its page and time; the tab still shows its error', async () => {
    const before = recentExtensionErrors('board').length;
    await report(GROUP_PAGE, 'written 50.7 times a second', 'hint');
    await report(SESSION_TAB, 'TypeError: x is undefined');
    const kept = recentExtensionErrors('board').slice(before);
    expect(kept).toEqual([
      { at: expect.any(String), message: 'written 50.7 times a second', level: 'hint', page: { tabKind: 'board.main', chatId: CHAT, itemId: ITEM, sessionId: null, tabId: 'slot-1' } },
      { at: expect.any(String), message: 'TypeError: x is undefined', level: 'error', page: { tabKind: 'board.main', chatId: null, itemId: null, sessionId: 'task-1', tabId: 'tab-1' } },
    ]);
    // Control: before F68 the task tab's error went to its tab only — delivered, and not in the record.
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('the check’s own page is not among them: what it reports goes to the check', async () => {
    await bindExtensionSurface({ webContentsId: CHECK_PAGE, extensionId: 'board', tabId: 'extension-check:9', tabKind: 'board.main', chatId: CHAT });
    const heard: string[] = [];
    const stop = watchExtensionSurfaceErrors(CHECK_PAGE, (message) => heard.push(message));
    const before = recentExtensionErrors('board').length;
    await report(CHECK_PAGE, 'from the check');
    expect(heard).toEqual(['from the check']);
    expect(recentExtensionErrors('board').length).toBe(before);
    stop();
    // Control: the same page, nobody reading it back — a real page, kept.
    await report(CHECK_PAGE, 'unwatched');
    expect(recentExtensionErrors('board').at(-1)?.message).toBe('unwatched');
  });
});

describe('an App page that tries to leave its origin (统筹 06:52)', () => {
  it('stays, and its author hears why — pointed at gugu.openBrowserTab, the address only as far as its origin', async () => {
    const { reportBlockedNavigation } = await import('./extension-bridge');
    const before = recentExtensionErrors('board').length;
    reportBlockedNavigation(GROUP_PAGE, 'https://elsewhere.example/path?token=secret');
    await Promise.resolve();
    const kept = recentExtensionErrors('board').slice(before);
    expect(kept).toEqual([expect.objectContaining({ level: 'error', page: expect.objectContaining({ chatId: CHAT }) })]);
    expect(kept[0]!.message).toContain('https://elsewhere.example');
    expect(kept[0]!.message).toContain('gugu.openBrowserTab');
    expect(kept[0]!.message).not.toContain('token=secret');
    // Control: before, the host only logged it — the App's record had nothing (a page that is no App's: nothing).
    reportBlockedNavigation(12345, 'https://elsewhere.example/');
    expect(recentExtensionErrors('board').length).toBe(before + 1);
  });
});
