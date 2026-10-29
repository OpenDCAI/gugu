import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `gugu.showSession(id)` (#7158): the session comes up the way a click on its row in the task list brings it. This
 * computer's session: found in its database. Another computer's: the window says which project its task list has it
 * under, over the App command channel (extensions.listedSession) — a window that cannot answer is `failed`, its reason
 * said. Either way it comes up the way an agent's banner brings its session up (notificationFocusSessionChannel), the
 * same as a session's `compose`. One spelling of the id; nothing for a page to learn.
 */

const GROUP_PAGE = 7;
const SESSION_TAB = 8;
const DOCK_PAGE = 10;
const CHECK_PAGE = 11;
const BACKGROUND = 9;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: vi.fn() });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => contentsOf(id) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'calendar',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => BACKGROUND }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => [],
    hasCapability: () => false,
    get: () => ({ manifest: { name: 'Calendar' } }),
  }),
}));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// This computer has one session its task list shows (s-here) and one archived (s-archived: sessionHere answers null for it,
// as for none — its own test reads the database).
vi.mock('@main/core/extensions/extension-show-session', async (original) => ({
  ...(await original<typeof import('./extension-show-session')>()),
  sessionHere: async (sessionId: string) => (sessionId === 's-here' ? 'p-here' : null),
}));
// The window, over the App command channel (relay → renderer command; the channel's own waits and refusals are
// ipc-bridge's): its task list has another computer's s-far under p-far — or it cannot answer, with the channel's reason.
const theWindow = vi.hoisted(() => ({ listed: new Map<string, string>(), cannot: null as Error | null }));
vi.mock('@main/core/extensions/extension-bridge-relay', () => ({
  // The window opens no session itself here (only the assistant's own task opens in its chat).
  actInWindow: vi.fn(async () => undefined),
  listedSessionProject: vi.fn(async (sessionId: string) => {
    if (theWindow.cannot) throw theWindow.cannot;
    return theWindow.listed.get(sessionId) ?? null;
  }),
}));
// Main's events, in memory (the real one broadcasts to windows): what main brings up is read off it below.
vi.mock('@main/lib/events', async () => {
  const { EventEmitter } = await import('node:events');
  const { createEventEmitter } = await import('@shared/lib/ipc/events');
  const bus = new EventEmitter();
  const channelOf = (name: string, topic?: string) => (topic ? `${name}.${topic}` : name);
  return {
    tapMainEvents: () => () => undefined,
    events: createEventEmitter({
      emit: (name: string, data: unknown, topic?: string) => void bus.emit(channelOf(name, topic), data),
      on: (name: string, cb: (data: unknown) => void, topic?: string) => {
        bus.on(channelOf(name, topic), cb);
        return () => void bus.off(channelOf(name, topic), cb);
      },
    }),
  };
});
// Whose composer is extension-send's (its own test); here: an agent's session comes up the one way before its composer.
vi.mock('@main/core/extensions/extension-send', () => ({
  dispatchForApp: async (_id: string, args: { text: string }, _here: unknown, effects: { draftInSession(session: { id: string; projectId: string }, text: string): Promise<void> }) => {
    await effects.draftInSession({ id: 's-here', projectId: 'p-here' }, `${args.text}\n`);
    return { to: { agent: 'user:0a000000-0000-4000-8000-0000000000a3' } };
  },
}));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { listedSessionProject } = await import('@main/core/extensions/extension-bridge-relay');
const { events } = await import('@main/lib/events');
const { notificationFocusSessionChannel } = await import('@shared/events/appEvents');
const emitted = vi.spyOn(events, 'emit');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown>) =>
  handle({ sender: { id: sender, session: {} } }, { method, args }) as Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>;
const show = (sender: number, id: unknown) => call(sender, 'showSession', { id });
/** What main brought up: every focus it emitted, as the window receives it. */
const broughtUp = () => emitted.mock.calls.filter(([channel]) => channel === notificationFocusSessionChannel).map(([, payload]) => payload);
/** What main asked the window about: every session it asked the task list for. */
const asked = () => vi.mocked(listedSessionProject).mock.calls.map(([sessionId]) => sessionId);

const deliver = vi.fn((_origin: unknown, _action: unknown) => Promise.resolve());

beforeEach(async () => {
  emitted.mockClear();
  deliver.mockClear();
  vi.mocked(listedSessionProject).mockClear();
  theWindow.listed = new Map([['s-far', 'p-far']]);
  theWindow.cannot = null;
  setExtensionBridgeHost({
    deliver,
    presentation: () => ({ locale: 'en', themeMode: 'light' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: GROUP_PAGE, extensionId: 'calendar', tabId: 'slot-1', tabKind: 'calendar.main', chatId: '0b000000-0000-4000-8000-0000000000a1' });
  await bindExtensionSurface({ webContentsId: SESSION_TAB, extensionId: 'calendar', sessionId: 's-here', tabId: 'tab-1', tabKind: 'calendar.main' });
  await bindExtensionSurface({ webContentsId: DOCK_PAGE, extensionId: 'calendar', tabId: 'dock', tabKind: 'calendar.main' });
  await bindExtensionSurface({ webContentsId: CHECK_PAGE, extensionId: 'calendar', tabId: 'extension-check:11', tabKind: 'calendar.main', operator: { kind: 'agent', id: 'user:agent-f' } });
});

describe('gugu.showSession: the session comes up as a click on its row in the task list brings it', () => {
  it('a session here: brought up by its project, from a page wherever it is — the window is not asked, the page told nothing', async () => {
    for (const page of [SESSION_TAB, GROUP_PAGE, DOCK_PAGE]) expect(await show(page, 's-here')).toEqual({ ok: true, value: undefined });
    expect(broughtUp()).toEqual([
      { projectId: 'p-here', sessionId: 's-here' },
      { projectId: 'p-here', sessionId: 's-here' },
      { projectId: 'p-here', sessionId: 's-here' },
    ]);
    expect(asked()).toEqual([]);
  });

  it("another computer's session the task list has: brought up the same way, under the project the window lists it in", async () => {
    expect(await show(SESSION_TAB, 's-far')).toEqual({ ok: true, value: undefined });
    expect(asked()).toEqual(['s-far']);
    expect(broughtUp()).toEqual([{ projectId: 'p-far', sessionId: 's-far' }]);
  });

  it('one the task list does not have: not-found, said — nothing comes up', async () => {
    expect(await show(SESSION_TAB, 's-gone')).toEqual({
      ok: false,
      code: 'not-found',
      message: 'Session s-gone is not on this computer or in your task list',
    });
    expect(asked()).toEqual(['s-gone']);
    // An archived session of this computer: not in the list either (sessionHere has none), so the same answer.
    expect(await show(SESSION_TAB, 's-archived')).toMatchObject({ ok: false, code: 'not-found' });
    expect(broughtUp()).toEqual([]);
  });

  it("a window that cannot answer (past the command's wait, reloading, not up): failed, its reason said — nothing comes up", async () => {
    for (const reason of ['IPC timeout: extensions:cmd/extensions.listedSession', 'Renderer navigated before command response', 'Renderer not ready']) {
      theWindow.cannot = new Error(reason);
      expect(await show(SESSION_TAB, 's-far')).toEqual({
        ok: false,
        code: 'failed',
        message: `The task page did not answer (${reason}): try again once it shows`,
      });
    }
    expect(broughtUp()).toEqual([]);
    // Control: the window answers, and the same call brings it up.
    theWindow.cannot = null;
    expect(await show(SESSION_TAB, 's-far')).toEqual({ ok: true, value: undefined });
    expect(broughtUp()).toEqual([{ projectId: 'p-far', sessionId: 's-far' }]);
  });

  it('one spelling: an address or no id at all is invalid, saying which to pass — never looked up, never translated', async () => {
    for (const id of ['user:0a000000-0000-4000-8000-0000000000a1', 'session:s-here', 'aid:s-here']) {
      const answer = await show(SESSION_TAB, id);
      expect([id, answer.ok, answer.code]).toEqual([id, false, 'invalid']);
      expect(answer.message).toBe(`${JSON.stringify(id)} is an address, not a session's id: pass the session's id, as ctx.session.id gives it`);
    }
    for (const id of [undefined, '', 42, { session: 's-here' }]) {
      expect(await show(SESSION_TAB, id)).toEqual({
        ok: false,
        code: 'invalid',
        message: "Say which session: its id, as ctx.session.id gives it (listAgents' sessionId, a tool call's call.session)",
      });
    }
    expect(broughtUp()).toEqual([]);
    expect(asked()).toEqual([]);
    // Control: the very id these were written around comes up.
    expect(await show(SESSION_TAB, 's-here')).toMatchObject({ ok: true });
    expect(broughtUp()).toEqual([{ projectId: 'p-here', sessionId: 's-here' }]);
  });

  it("a page's own: the background page has no click to bring it from; a page an agent works hands it back and brings nothing up (owner 10-14)", async () => {
    expect(await show(BACKGROUND, 's-here')).toMatchObject({ ok: false });
    expect(await show(CHECK_PAGE, 's-here')).toEqual({ ok: true, value: undefined });
    expect(await show(CHECK_PAGE, 's-far')).toEqual({ ok: true, value: undefined });
    expect(broughtUp()).toEqual([]);
    expect(asked()).toEqual([]);
  });

  /** G1 (kanban 10-19): beside the App, the page left as it is — found the same way, told to the slot the page is drawn in. */
  it('peek: the session goes to the slot of the page that asked, found the same way — nothing is brought up', async () => {
    expect(await call(GROUP_PAGE, 'showSession', { id: 's-here', peek: true })).toEqual({ ok: true, value: undefined });
    expect(await call(DOCK_PAGE, 'showSession', { id: 's-far', peek: true })).toEqual({ ok: true, value: undefined });
    expect(broughtUp()).toEqual([]);
    expect(deliver.mock.calls).toEqual([
      [expect.objectContaining({ sessionId: null, tabId: 'slot-1' }), { kind: 'peek', target: { kind: 'session', sessionId: 's-here', projectId: 'p-here' } }],
      [expect.objectContaining({ sessionId: null, tabId: 'dock' }), { kind: 'peek', target: { kind: 'session', sessionId: 's-far', projectId: 'p-far' } }],
    ]);
    // One it cannot find is refused as without peek; nothing goes to the slot.
    expect(await call(GROUP_PAGE, 'showSession', { id: 's-gone', peek: true })).toMatchObject({ ok: false, code: 'not-found' });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("a draft into an agent's session brings it up the same one way, before its composer gets the text", async () => {
    expect(await call(SESSION_TAB, 'dispatch', { text: 'about this', draft: true, to: { agent: 'user:0a000000-0000-4000-8000-0000000000a3' } })).toMatchObject({ ok: true });
    expect(broughtUp()).toEqual([{ projectId: 'p-here', sessionId: 's-here' }]);
    expect(deliver.mock.calls.map(([, action]) => action)).toEqual([{ kind: 'compose', sessionId: 's-here', text: 'about this\n' }]);
    const focusAt = emitted.mock.calls.findIndex(([channel]) => channel === notificationFocusSessionChannel);
    expect(emitted.mock.invocationCallOrder[focusAt]).toBeLessThan(deliver.mock.invocationCallOrder[0]!);
  });
});
