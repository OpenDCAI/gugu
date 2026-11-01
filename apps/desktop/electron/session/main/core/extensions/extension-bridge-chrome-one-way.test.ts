import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
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
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// Whom it goes to, and what goes, is extension-send's (its own test); here: what the bridge brings it — the page's chat and
// session, the window's sheet and composers — and what it does with the answer. The fake drives each effect as the real one.
const dispatchForApp = vi.fn(async (_id: string, args: Record<string, unknown>, here: Record<string, unknown>, effects: {
  pick(ask: unknown): Promise<unknown>;
  draftInChat(detail: unknown): Promise<void>;
  draftInSession(session: { id: string; projectId: string }, text: string): Promise<void>;
}) => {
  const text = String(args.text ?? '').trim();
  if (!text) throw Object.assign(new Error('Say something: text is empty'), { code: 'invalid' });
  let to = args.to as Record<string, string> | undefined;
  if (!to) {
    const picked = (await effects.pick({ draft: args.draft === true, here })) as { to: Record<string, string> } | null;
    if (!picked) return { cancelled: true };
    to = picked.to;
  }
  if (to.chat) await effects.draftInChat({ chatId: to.chat, text: `${text}\n` });
  else await effects.draftInSession({ id: to.session ?? 'task-2', projectId: 'p-1' }, `${text}\n`);
  return { to };
});
vi.mock('@main/core/extensions/extension-send', () => ({ dispatchForApp }));
// The window's sheet (DispatchSheet): what the person picked, or null — asked only when the call named no target.
const pickDispatchTarget = vi.fn(async (_embedderId: number | null, _ask: unknown): Promise<unknown> => null);
vi.mock('@main/core/extensions/extension-bridge-relay', () => ({ pickDispatchTarget, actInWindow: async () => undefined, listedSessionProject: async () => null }));
// The session a draft goes to is this computer's (the one way a session is opened finds it here).
vi.mock('@main/core/extensions/extension-show-session', async (original) => ({
  ...(await original<typeof import('./extension-show-session')>()),
  sessionHere: async (sessionId: string) => (sessionId === 'task-2' ? 'p-1' : null),
}));

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
  await bindExtensionSurface({ webContentsId: GROUP_PAGE, extensionId: 'board', tabId: 'slot-1', tabKind: 'board.main', conversation: CHAT });
  await bindExtensionSurface({ webContentsId: SESSION_TAB, extensionId: 'board', workspace: sessionWorkspace('task-1'), tabId: 'tab-1', tabKind: 'board.main' });
  await bindExtensionSurface({ webContentsId: UNSHOWN_PAGE, extensionId: 'board', tabId: 'extension-check:9', tabKind: 'board.main', conversation: CHAT });
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
  it('a draft goes the same way out, to the composer the call names — a chat\'s, or a session\'s brought on screen first', async () => {
    const OTHER = '0b000000-0000-4000-8000-00000000c012';
    expect(await call(GROUP_PAGE, 'dispatch', { text: 'picked', draft: true, to: { chat: OTHER } })).toMatchObject({ ok: true });
    expect(await call(SESSION_TAB, 'dispatch', { text: 'picked', draft: true, to: { agent: 'user:0a000000-0000-4000-8000-0000000000a2' } })).toMatchObject({ ok: true });
    expect(await call(DOCK_PAGE, 'dispatch', { text: 'picked', draft: true, to: { chat: CHAT } })).toMatchObject({ ok: true });
    expect(deliver.mock.calls).toEqual([
      [{ extensionId: 'board', sessionId: null, tabId: 'slot-1', embedderId: 42 }, { kind: 'compose', detail: { chatId: OTHER, text: 'picked\n' } }],
      [{ extensionId: 'board', sessionId: 'task-1', tabId: 'tab-1', embedderId: 42 }, { kind: 'compose', sessionId: 'task-2', text: 'picked\n' }],
      [{ extensionId: 'board', sessionId: null, tabId: 'dock-1', embedderId: 42 }, { kind: 'compose', detail: { chatId: CHAT, text: 'picked\n' } }],
    ]);
    expect(emitted).toHaveBeenCalledWith(expect.anything(), { projectId: 'p-1', sessionId: 'task-2' });
    // Where the page is fills only what the sheet shows: its session.
    expect(dispatchForApp.mock.calls[1]![2]).toMatchObject({ session: 'task-1' });
    deliver.mockClear();
    expect(await call(GROUP_PAGE, 'dispatch', { text: '   ', draft: true, to: { chat: CHAT } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('naming no target asks the window that draws the page; the App hears only what was picked, or that they cancelled', async () => {
    pickDispatchTarget.mockResolvedValueOnce({ to: { agent: 'user:0a000000-0000-4000-8000-0000000000a2' }, visible: false, text: 'ask about this' });
    expect(await call(SESSION_TAB, 'dispatch', { text: 'ask about this', draft: true })).toEqual({ ok: true, value: { to: { agent: 'user:0a000000-0000-4000-8000-0000000000a2' } } });
    expect(pickDispatchTarget).toHaveBeenLastCalledWith(42, expect.objectContaining({ draft: true }));
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'task-1' }), { kind: 'compose', sessionId: 'task-2', text: 'ask about this\n' });

    // Cancelled: nothing goes anywhere, and the App hears so.
    deliver.mockClear();
    pickDispatchTarget.mockResolvedValueOnce(null);
    expect(await call(DOCK_PAGE, 'dispatch', { text: 'never mind' })).toEqual({ ok: true, value: { cancelled: true } });
    expect(deliver).not.toHaveBeenCalled();
  });
});
