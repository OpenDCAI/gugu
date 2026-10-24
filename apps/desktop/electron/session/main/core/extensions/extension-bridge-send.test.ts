import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 摩擦单 F16 `gugu.send` 过桥:一条悄悄话,发在调用点名的那个 chat 里(`chat`,或 `refs` 指的文件所在的 chat);门口按动词那一行
 * 要 `chat:relay`。告诉自己的 agent 是另一个动词 `messageAgent`,门口要 `agents:control`。页面在哪不参与(真源原则 13):
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
const sendFromApp = vi.fn();
const messageAgentFromApp = vi.fn();
vi.mock('@main/core/extensions/extension-send', () => ({
  sendFromApp: (...args: unknown[]) => sendFromApp(...args),
  messageAgentFromApp: (...args: unknown[]) => messageAgentFromApp(...args),
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
const call = (sender: number, args: Record<string, unknown>, method = 'send') =>
  handle({ sender: { id: sender, session: {} } }, { method, args });

const AGENT = 'user:0a000000-0000-4000-8000-000000000016';
const CHAT = '0b000000-0000-4000-8000-000000000016';
const ITEM = '0c000000-0000-4000-8000-000000000016';
const ENTRY = { chat: CHAT, id: ITEM, name: 'game.chess.json' };

beforeEach(async () => {
  granted.clear();
  sendFromApp.mockReset();
  messageAgentFromApp.mockReset();
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'chess', tabId: 'tab-1', tabKind: 'chess.main', chatId: CHAT });
});

describe('gugu.send over the bridge (F16)', () => {
  it('with chat:relay: handed over as the call names it, and the id comes back', async () => {
    granted.add('chat:relay');
    sendFromApp.mockResolvedValue({ id: 'm-1' });
    const result = await call(PAGE, { to: AGENT, text: 'e2e4 — your move', refs: [{ file: ENTRY }] });
    expect(result).toEqual({ ok: true, value: { id: 'm-1' } });
    expect(sendFromApp).toHaveBeenCalledWith('chess', { to: AGENT, text: 'e2e4 — your move', refs: [{ file: ENTRY }] }, {});
  });

  it('the door asks chat:relay, from the verb\'s row: without it, refused there and nothing handed over', async () => {
    const result = await call(PAGE, { to: AGENT, text: 'e2e4', chat: CHAT });
    expect(result).toEqual({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "chat:relay"' });
    expect(sendFromApp).not.toHaveBeenCalled();
  });

  it('counter-cells: someone outside the chat and the server limit keep their code — not-found (F78), rate-limited', async () => {
    granted.add('chat:relay');
    const refusal = (code: string, message: string) => Object.assign(new Error(message), { code });
    sendFromApp.mockRejectedValueOnce(refusal('not-found', `${AGENT} is not in this chat`));
    expect(await call(PAGE, { to: AGENT, text: 'hi', chat: CHAT })).toEqual({ ok: false, code: 'not-found', message: `${AGENT} is not in this chat` });
    sendFromApp.mockRejectedValueOnce(refusal('rate-limited', 'rate-limited: 30 a minute'));
    expect(await call(PAGE, { to: AGENT, text: 'hi', chat: CHAT })).toEqual({ ok: false, code: 'rate-limited', message: 'rate-limited: 30 a minute' });
  });

  // Control (the parent commit a770f2e40d): the page's chat went along as where to send, and the background page went
  // along as "in no chat" — the same call meant two things.
  it('the background page: the same call, handed over the same — where a page is plays no part', async () => {
    granted.add('chat:relay');
    sendFromApp.mockResolvedValue({ id: 'm-2' });
    expect(await call(BACKGROUND, { to: AGENT, text: 'ready', chat: CHAT })).toEqual({ ok: true, value: { id: 'm-2' } });
    expect(sendFromApp).toHaveBeenCalledWith('chess', { to: AGENT, text: 'ready', chat: CHAT }, {});
  });

  it('messageAgent: its own verb and its own word at the door (agents:control)', async () => {
    expect(await call(PAGE, { agentId: AGENT, text: 'run it' }, 'messageAgent')).toMatchObject({ ok: false, code: 'denied' });
    granted.add('agents:control');
    messageAgentFromApp.mockResolvedValue({ id: 'm-4' });
    expect(await call(PAGE, { agentId: AGENT, text: 'run it' }, 'messageAgent')).toEqual({ ok: true, value: { id: 'm-4' } });
    expect(messageAgentFromApp).toHaveBeenCalledWith('chess', { agentId: AGENT, text: 'run it' }, {});
    expect(sendFromApp).not.toHaveBeenCalled();
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

  it('its send goes, written as that agent; the agent it tells is told from that agent’s session, and the one it starts is its child', async () => {
    granted.add('chat:relay');
    granted.add('agents:control');
    sendFromApp.mockResolvedValue({ id: 'm-3' });
    messageAgentFromApp.mockResolvedValue({ id: 'm-5' });
    spawnAgentForExtension.mockResolvedValue({ agentId: AGENT });
    expect(await call(CHECK, { to: AGENT, text: 'your move', refs: [{ file: ENTRY }] })).toEqual({ ok: true, value: { id: 'm-3' } });
    expect(sendFromApp).toHaveBeenCalledWith('chess', { to: AGENT, text: 'your move', refs: [{ file: ENTRY }] }, { as: WORKER.slice('user:'.length) });
    expect(await call(CHECK, { agentId: AGENT, text: 'run it' }, 'messageAgent')).toEqual({ ok: true, value: { id: 'm-5' } });
    expect(messageAgentFromApp).toHaveBeenCalledWith('chess', { agentId: AGENT, text: 'run it' }, { from: 'session-f' });
    expect(await call(CHECK, { prompt: 'help' }, 'spawnAgent')).toEqual({ ok: true, value: { agentId: AGENT } });
    expect(spawnAgentForExtension).toHaveBeenCalledWith(expect.objectContaining({ extensionId: 'chess', prompt: 'help', bySession: 'session-f' }));
    // Stopped by the agent that works the page: its session goes along, so it cannot stop itself (session_stop's check).
    expect(await call(CHECK, { agentId: AGENT }, 'stopAgent')).toEqual({ ok: true, value: undefined });
    expect(stopAgentForExtension).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, bySession: 'session-f' }));
    expect(checkReadingsOf(CHECK)).toBeNull();
    // Control: the group’s page, worked by the person, tells and starts from no session.
    await call(PAGE, { agentId: AGENT, text: 'run it' }, 'messageAgent');
    expect(messageAgentFromApp).toHaveBeenLastCalledWith('chess', { agentId: AGENT, text: 'run it' }, {});
    await call(PAGE, { prompt: 'help' }, 'spawnAgent');
    expect(spawnAgentForExtension).toHaveBeenLastCalledWith(expect.objectContaining({ bySession: undefined }));
  });

  it('the agent gone from this computer: it tells no one, and says so', async () => {
    granted.add('agents:control');
    roster.clear();
    expect(await call(CHECK, { agentId: AGENT, text: 'run it' }, 'messageAgent')).toMatchObject({ ok: false, message: expect.stringContaining('no longer on this computer') });
    expect(messageAgentFromApp).not.toHaveBeenCalled();
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
