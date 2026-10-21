import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L11 复核 11: what a page says about itself (`setTabTitle` / `setTabBadge` / `reportError`) took two ways out of main —
 * a task's tab through the host's `deliver`, a group's page through a window event of its own (`drawOnSlot` → preload →
 * the slot's listener). Both ended in the same store. Now there is one: `deliver`, a slot in no task saying so with
 * `sessionId: null`; the renderer keeps it by page.
 */

const GROUP_PAGE = 7;
const SESSION_TAB = 8;
const UNSHOWN_PAGE = 9;
const DOCK_PAGE = 10;
const contentsOf = (id: number) => ({
  id,
  isDestroyed: () => false,
  // `app_check`'s page is a hidden window of its own: nothing embeds it.
  hostWebContents: id === UNSHOWN_PAGE ? undefined : { id: 42 },
  session: {},
  once: () => undefined,
  on: () => undefined,
  send: vi.fn(),
});
const contents = new Map([GROUP_PAGE, SESSION_TAB, UNSHOWN_PAGE, DOCK_PAGE].map((id) => [id, contentsOf(id)]));
const embedder = { id: 42, isDestroyed: () => false, send: vi.fn() };

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => (id === 42 ? embedder : contents.get(id)) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'board',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => ['chat:relay'],
    hasCapability: () => true,
    get: () => ({ manifest: { name: 'Board' } }),
  }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Whose composer, and what goes in, is extension-send's (its own test); here: what the bridge does with its answer.
const composeTarget = vi.fn(async (args: { text: unknown; chat?: unknown; session?: unknown }) => {
  if (!String(args.text ?? '').trim()) throw Object.assign(new Error('Nothing to compose: text is empty'), { code: 'invalid' });
  return args.session
    ? { session: { id: String(args.session), projectId: 'p-1' }, text: `${String(args.text)}\n` }
    : { chatId: String(args.chat), text: `${String(args.text)}\n` };
});
vi.mock('@main/core/extensions/extension-send', () => ({ composeTarget }));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost, recentExtensionErrors } = await import('./extension-bridge');
const { events } = await import('@main/lib/events');
const emitted = vi.spyOn(events, 'emit');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown>) =>
  handle({ sender: { id: sender, session: {} } }, { method, args }) as Promise<{ ok: boolean; error?: string }>;

const CHAT = '0b000000-0000-4000-8000-00000000c011';
const deliver = vi.fn((_origin: unknown, _action: unknown) => Promise.resolve());

beforeEach(async () => {
  deliver.mockClear();
  embedder.send.mockClear();
  setExtensionBridgeHost({
    deliver,
    presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: GROUP_PAGE, extensionId: 'board', tabId: 'slot-1', tabKind: 'board.main', chatId: CHAT });
  await bindExtensionSurface({ webContentsId: SESSION_TAB, extensionId: 'board', sessionId: 'task-1', tabId: 'tab-1', tabKind: 'board.main' });
  await bindExtensionSurface({ webContentsId: UNSHOWN_PAGE, extensionId: 'board', tabId: 'extension-check:9', tabKind: 'board.main', chatId: CHAT });
  await bindExtensionSurface({ webContentsId: DOCK_PAGE, extensionId: 'board', tabId: 'dock-1', tabKind: 'board.main' });
});

describe('what a page says about itself: one way out of main', () => {
  it('a group page’s title, badge and error go out as a task tab’s do — through deliver, its slot in no task', async () => {
    expect(await call(GROUP_PAGE, 'setTabTitle', { title: 'Board' })).toMatchObject({ ok: true });
    expect(await call(GROUP_PAGE, 'setTabBadge', { badge: 3 })).toMatchObject({ ok: true });
    expect(await call(GROUP_PAGE, 'reportError', { message: 'boom' })).toMatchObject({ ok: true });
    const group = { extensionId: 'board', sessionId: null, tabId: 'slot-1', embedderId: 42 };
    expect(deliver.mock.calls).toEqual([
      [group, { kind: 'setTabTitle', title: 'Board' }],
      [group, { kind: 'setTabBadge', badge: 3 }],
      [group, { kind: 'reportError', message: 'boom' }],
    ]);
    // Nothing else reaches the window: the group's own event (`app-tab-chrome`) is gone.
    expect(embedder.send).not.toHaveBeenCalled();

    // Control: a task's tab, the way it always went — the same three, its task named.
    deliver.mockClear();
    await call(SESSION_TAB, 'setTabTitle', { title: 'Board' });
    await call(SESSION_TAB, 'reportError', { message: 'boom' });
    const tab = { extensionId: 'board', sessionId: 'task-1', tabId: 'tab-1', embedderId: 42 };
    expect(deliver.mock.calls).toEqual([
      [tab, { kind: 'setTabTitle', title: 'Board' }],
      [tab, { kind: 'reportError', message: 'boom' }],
    ]);
  });

  it('a page drawn nowhere (app_check’s) has no header: its calls still succeed, nothing is delivered, its error is kept', async () => {
    const before = recentExtensionErrors('board').length;
    expect(await call(UNSHOWN_PAGE, 'setTabTitle', { title: 'Board' })).toMatchObject({ ok: true });
    expect(await call(UNSHOWN_PAGE, 'setTabBadge', { badge: null })).toMatchObject({ ok: true });
    expect(await call(UNSHOWN_PAGE, 'reportError', { message: 'unwatched' })).toMatchObject({ ok: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(recentExtensionErrors('board').slice(before).map((record) => record.message)).toEqual(['unwatched']);
    // Control: a hint is for the App's author — kept, said nowhere, on a page that is drawn too.
    await call(GROUP_PAGE, 'reportError', { message: 'written fast', level: 'hint' });
    expect(deliver).not.toHaveBeenCalled();
  });

  // Control (the parent commit a770f2e40d): a group page composed into its chat, a session tab into its session, and the
  // dock's page was refused — where the page was chose the composer.
  it('compose goes the same way out, to the composer the call names — a chat\'s, or a session\'s brought on screen first', async () => {
    const OTHER = '0b000000-0000-4000-8000-00000000c012';
    expect(await call(GROUP_PAGE, 'compose', { text: 'picked', chat: OTHER })).toMatchObject({ ok: true });
    expect(await call(SESSION_TAB, 'compose', { text: 'picked', session: 'task-2' })).toMatchObject({ ok: true });
    expect(await call(DOCK_PAGE, 'compose', { text: 'picked', chat: CHAT })).toMatchObject({ ok: true });
    expect(deliver.mock.calls).toEqual([
      [{ extensionId: 'board', sessionId: null, tabId: 'slot-1', embedderId: 42 }, { kind: 'compose', detail: { chatId: OTHER, text: 'picked\n' } }],
      [{ extensionId: 'board', sessionId: 'task-1', tabId: 'tab-1', embedderId: 42 }, { kind: 'compose', sessionId: 'task-2', text: 'picked\n' }],
      [{ extensionId: 'board', sessionId: null, tabId: 'dock-1', embedderId: 42 }, { kind: 'compose', detail: { chatId: CHAT, text: 'picked\n' } }],
    ]);
    expect(emitted).toHaveBeenCalledWith(expect.anything(), { projectId: 'p-1', sessionId: 'task-2' });
    deliver.mockClear();
    expect(await call(GROUP_PAGE, 'compose', { text: '   ', chat: CHAT })).toMatchObject({ ok: false, code: 'invalid' });
    expect(deliver).not.toHaveBeenCalled();
  });
});
