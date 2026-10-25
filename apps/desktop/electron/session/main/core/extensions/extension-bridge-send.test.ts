import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `gugu.dispatch`(15)过桥:门口按动词那一行、按调用点名的对象要能力 —— 群成员 `chat:relay`,这个人的 agent / 新 agent
 * `agents:control`,人在 sheet 里选的不要。页面在哪只填 sheet 要列的(页面所在的群、它的会话),❌ 决定发到哪(真源原则 13):
 * 群里的页和后台页交出去的是同一份参数。服务端的限速以 `rate-limited` 交给 App(它据此退避),❌ 折成 failed。
 */

const PAGE = 7;
const BACKGROUND = 9;
const CHECK = 11;
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => (id === PAGE || id === BACKGROUND || id === CHECK ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'chess',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => BACKGROUND }));
const granted = new Set<string>();
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => [...granted],
    hasCapability: (_id: string, wanted: string) => granted.has(wanted),
    get: () => ({ manifest: { name: 'Chess' } }),
    agentReach: () => 'own',
  }),
}));
const dispatchForApp = vi.fn();
vi.mock('@main/core/extensions/extension-send', () => ({
  dispatchForApp: (...args: unknown[]) => dispatchForApp(...args),
}));
const spawnAgentForExtension = vi.fn();
const stopAgentForExtension = vi.fn();
vi.mock('@main/core/extensions/extension-agents', () => ({
  spawnAgentForExtension: (...args: unknown[]) => spawnAgentForExtension(...args),
  stopAgentForExtension: (...args: unknown[]) => stopAgentForExtension(...args),
  visibleAgentsForExtension: async () => new Map([['user:0a000000-0000-4000-8000-000000000016', 'session-a']]),
}));
const roster = new Map<string, string>();
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => roster }));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge, checkReadingsOf } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, args: Record<string, unknown>, method = 'dispatch') =>
  handle({ sender: { id: sender, session: {} } }, { method, args });

const AGENT = 'user:0a000000-0000-4000-8000-000000000016';
const CHAT = '0b000000-0000-4000-8000-000000000016';
const ITEM = '0c000000-0000-4000-8000-000000000016';
const ENTRY = { chat: CHAT, id: ITEM, name: 'game.chess.json' };

beforeEach(async () => {
  granted.clear();
  dispatchForApp.mockReset();
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'chess', tabId: 'tab-1', tabKind: 'chess.main', chatId: CHAT });
});

const MEMBER = { chat: CHAT, member: AGENT };
/** What the bridge handed `dispatchForApp`: the call as it came, where the page is, and who works it. */
const handed = () => dispatchForApp.mock.calls.at(-1) as [string, Record<string, unknown>, Record<string, unknown>, { from?: string }];

describe('gugu.dispatch over the bridge', () => {
  it('to a member, with chat:relay: handed over as the call names it, the page\'s chat for the sheet, and the id comes back', async () => {
    granted.add('chat:relay');
    dispatchForApp.mockResolvedValue({ to: MEMBER, id: 'm-1' });
    const result = await call(PAGE, { to: MEMBER, text: 'e2e4 — your move', refs: [{ file: ENTRY }] });
    expect(result).toEqual({ ok: true, value: { to: MEMBER, id: 'm-1' } });
    expect(handed()[0]).toBe('chess');
    expect(handed()[1]).toEqual({ to: MEMBER, text: 'e2e4 — your move', refs: [{ file: ENTRY }] });
    expect(handed()[2]).toMatchObject({ current: null });
    expect(handed()[2]).not.toHaveProperty('as');
    expect(handed()[3].from).toBeUndefined();
  });

  it('the door asks what the target needs, from the verb\'s row: without it, refused there and nothing handed over', async () => {
    expect(await call(PAGE, { to: MEMBER, text: 'e2e4' })).toEqual({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "chat:relay"' });
    expect(await call(PAGE, { to: { agent: AGENT }, text: 'run it' })).toEqual({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "agents:control"' });
    expect(await call(PAGE, { to: { new: true }, text: 'help' })).toEqual({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "agents:control"' });
    expect(dispatchForApp).not.toHaveBeenCalled();
    // The person picks in the sheet: no capability asked at all.
    dispatchForApp.mockResolvedValue({ cancelled: true });
    expect(await call(PAGE, { text: 'whom?' })).toEqual({ ok: true, value: { cancelled: true } });
  });

  it('counter-cells: someone outside the chat and the server limit keep their code — not-found (F78), rate-limited', async () => {
    granted.add('chat:relay');
    const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });
    dispatchForApp.mockRejectedValueOnce(refusal('not-found', `${AGENT} is not in this chat`));
    expect(await call(PAGE, { to: MEMBER, text: 'hi' })).toEqual({ ok: false, code: 'not-found', message: `${AGENT} is not in this chat` });
    dispatchForApp.mockRejectedValueOnce(refusal('rate-limited', 'rate-limited: 30 a minute'));
    expect(await call(PAGE, { to: MEMBER, text: 'hi' })).toEqual({ ok: false, code: 'rate-limited', message: 'rate-limited: 30 a minute' });
  });

  // Control (the parent commit a770f2e40d): the page's chat went along as where to send, and the background page went
  // along as "in no chat" — the same call meant two things.
  it('the background page: the same call, handed over the same — where a page is plays no part', async () => {
    granted.add('chat:relay');
    dispatchForApp.mockResolvedValue({ to: MEMBER, id: 'm-2' });
    expect(await call(BACKGROUND, { to: MEMBER, text: 'ready' })).toEqual({ ok: true, value: { to: MEMBER, id: 'm-2' } });
    expect(handed()[1]).toEqual({ to: MEMBER, text: 'ready' });
    expect(handed()[2]).toEqual({ chat: null, current: null });
  });
});

describe('the check’s page, worked by the agent that asks (owner 10-14)', () => {
  const WORKER = 'user:0a000000-0000-4000-8000-0000000000f1';
  beforeEach(async () => {
    roster.clear();
    roster.set('session-f', WORKER);
    spawnAgentForExtension.mockReset();
    stopAgentForExtension.mockReset();
    await bindExtensionSurface({ webContentsId: CHECK, extensionId: 'chess', tabId: 'check', tabKind: 'chess.main', chatId: CHAT, operator: { kind: 'agent', id: WORKER } });
  });

  it('a named target goes, as that agent: written as it to a chat, told and started from its session; the sheet is handed back', async () => {
    granted.add('chat:relay');
    granted.add('agents:control');
    dispatchForApp.mockResolvedValue({ to: MEMBER, id: 'm-3' });
    expect(await call(CHECK, { to: MEMBER, text: 'your move', refs: [{ file: ENTRY }] })).toEqual({ ok: true, value: { to: MEMBER, id: 'm-3' } });
    expect(handed()[2]).toMatchObject({ as: WORKER.slice('user:'.length) });
    expect(handed()[3].from).toBe('session-f');
    // Stopped by the agent that works the page: its session goes along, so it cannot stop itself (session_stop's check).
    expect(await call(CHECK, { agentId: AGENT }, 'stopAgent')).toEqual({ ok: true, value: undefined });
    expect(stopAgentForExtension).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, bySession: 'session-f' }));
    expect(checkReadingsOf(CHECK)).toBeNull();
    // No target: the person's sheet is not the agent's — handed back to it, answered as cancelled, nothing dispatched.
    dispatchForApp.mockClear();
    expect(await call(CHECK, { text: 'whom?' })).toEqual({ ok: true, value: { cancelled: true } });
    expect(dispatchForApp).not.toHaveBeenCalled();
    expect(checkReadingsOf(CHECK)?.shown).toEqual([{ verb: 'dispatch', detail: '{"text":"whom?"}' }]);
    // Control: the group’s page, worked by the person, tells and starts from no session.
    dispatchForApp.mockResolvedValue({ to: { agent: AGENT }, id: 'm-4' });
    await call(PAGE, { to: { agent: AGENT }, text: 'run it' });
    expect(handed()[3].from).toBeUndefined();
  });

  it('the agent gone from this computer: it tells no one, and says so', async () => {
    granted.add('agents:control');
    roster.clear();
    expect(await call(CHECK, { to: { agent: AGENT }, text: 'run it' })).toMatchObject({ ok: false, message: expect.stringContaining('no longer on this computer') });
    expect(dispatchForApp).not.toHaveBeenCalled();
  });

  it('its counts come back; a real page that reports counts is not heard', async () => {
    expect(checkReadingsOf(CHECK)).toBeNull();
    await call(CHECK, { writes: 299, writesPerSecond: 59.8, presenceSets: 12, presencePerSecond: 3, opens: 1, opensSettled: 1 }, 'checkCounts');
    expect(checkReadingsOf(CHECK)).toEqual({ writes: 299, writesPerSecond: 60, presenceSets: 12, presencePerSecond: 3, opens: 1, opensSettled: 1, shown: [] });
    // Control: the group's real page.
    await call(PAGE, { writes: 5, writesPerSecond: 5, presenceSets: 0, presencePerSecond: 0 }, 'checkCounts');
    expect(checkReadingsOf(PAGE)).toBeNull();
  });
});
