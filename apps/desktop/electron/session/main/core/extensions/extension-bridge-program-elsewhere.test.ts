import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * owner 10-16「页面跟着人，程序跟着数据」: a page drawn in a session on another machine calls its program there, and that
 * program's notifications come back to it. A page of this computer's session, and one in a chat, keep this computer's
 * program; a notification from another machine reaches only the pages drawn in a session on that machine.
 */
const HERE = 7;
const THERE = 8;
const OTHER = 9;
const CHAT_PAGE = 10;
const sent = new Map<number, unknown[]>();
const contentsOf = (id: number) => ({
  id, isDestroyed: () => false, hostWebContents: null, session: {}, once: () => undefined, on: () => undefined,
  send: (_channel: string, event: unknown) => { sent.set(id, [...(sent.get(id) ?? []), event]); },
});
const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn), on: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: {},
  webContents: { fromId: (id: number) => ([HERE, THERE, OTHER, CHAT_PAGE].includes(id) ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'spexcode', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => ['files:read'],
    hasCapability: () => true,
    get: () => ({ manifest: { name: 'SpexCode', version: '0.7.0', contributes: { tabs: [], mcpServers: mcp.servers } } }),
  }),
  extensionDataRoot: () => '/data/spexcode',
}));
// The App's programs: its own by default; a test makes it one gugu hosts (Browser Use).
const mcp = vi.hoisted(() => ({ servers: [{ tools: 'tools.js' }] as Record<string, string>[] }));
const programs = { callFromPage: vi.fn(async () => ({ content: [{ type: 'text', text: 'here' }] })) };
const notified = vi.hoisted(() => ({ listener: null as null | ((id: string, server: string, n: { method: string; params?: unknown }) => void) }));
vi.mock('@main/core/extensions/extension-programs', () => ({
  extensionPrograms: programs,
  onExtensionProgramNotification: (fn: typeof notified.listener) => { notified.listener = fn; return () => undefined; },
}));
const emitted = vi.hoisted(() => [] as unknown[][]);
vi.mock('@main/lib/events', async (original) => ({
  ...(await original<typeof import('@main/lib/events')>()),
  events: { emit: (...args: unknown[]) => emitted.push(args), on: () => () => undefined },
}));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => new Map() }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async (id: string) => (id === 's-here' ? { sessionId: id, projectId: 'p-here', workspaceRoot: '/tmp' } : null),
}));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The other machines: s-there is on the server, s-other on a laptop.
const elsewhere = vi.hoisted(() => ({
  // That machine's answer: its program's, its data folder's.
  callOnSessionMachine: vi.fn(async (_app: unknown, sessionId: string, method: string, _args: Record<string, unknown>, _workedByAgent: boolean) =>
    (sessionId === 's-there' || sessionId === 's-other'
      ? { there: true as const, value: method === 'callProgram' ? { content: [{ type: 'text', text: 'there' }] } : 'there' }
      : { there: false as const })),
}));
// This computer's data folder.
const local = vi.hoisted(() => ({ read: vi.fn(() => 'here'), write: vi.fn(), list: vi.fn(() => []) }));
vi.mock('@main/core/extensions/extension-data', () => ({ readExtensionData: local.read, writeExtensionData: local.write, listExtensionData: local.list }));
const machineOf = vi.hoisted(() => (id: string) =>
  id === 's-there' ? { deviceId: 'dev-server', deviceLabel: 'server', projectId: 'p-there', agentId: 'user:0a000000-0000-4000-8000-0000000000b2' }
    : id === 's-other' ? { deviceId: 'dev-laptop', deviceLabel: 'laptop', projectId: null, agentId: null }
      : null);
vi.mock('./app-programs-elsewhere', () => ({
  sessionMachine: async (id: string) => machineOf(id),
  // What binding a page found (bindExtensionSurface resolves it then).
  knownSessionMachine: (id: string) => machineOf(id) ?? undefined,
  callOnSessionMachine: elsewhere.callOnSessionMachine,
}));

const { bindExtensionSurface, registerExtensionBridge, deliverProgramNotificationFrom, setExtensionBridgeHost } = await import('./extension-bridge');
setExtensionBridgeHost({
  presentation: () => ({ locale: 'en', themeMode: 'light', fullscreen: false, windowFocused: true }),
} as unknown as Parameters<typeof setExtensionBridgeHost>[0]);
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown> = {}) =>
  handle({ sender: { id: sender, session: {} } }, { method, args }) as Promise<{ ok: boolean; value?: unknown; code?: string }>;

beforeEach(async () => {
  sent.clear();
  emitted.length = 0;
  programs.callFromPage.mockClear();
  mcp.servers = [{ tools: 'tools.js' }];
  elsewhere.callOnSessionMachine.mockClear();
  local.read.mockClear();
  local.write.mockClear();
  await bindExtensionSurface({ webContentsId: HERE, extensionId: 'spexcode', tabId: 'a', tabKind: 'spexcode.spec', sessionId: 's-here' });
  await bindExtensionSurface({ webContentsId: THERE, extensionId: 'spexcode', tabId: 'b', tabKind: 'spexcode.spec', sessionId: 's-there' });
  await bindExtensionSurface({ webContentsId: OTHER, extensionId: 'spexcode', tabId: 'c', tabKind: 'spexcode.spec', sessionId: 's-other' });
  await bindExtensionSurface({ webContentsId: CHAT_PAGE, extensionId: 'spexcode', tabId: 'd', tabKind: 'spexcode.spec', chatId: '0b000000-0000-4000-8000-0000000000aa' });
});

describe('a page calls its program where its session is (owner 10-16)', () => {
  it('a session on another machine: the call goes there, with this App\'s version; here and in a chat: this computer\'s', async () => {
    expect(await call(THERE, 'callProgram', { name: 'graph', arguments: { a: 1 } })).toEqual({ ok: true, value: { content: [{ type: 'text', text: 'there' }] } });
    expect(elsewhere.callOnSessionMachine).toHaveBeenCalledWith(
      { extensionId: 'spexcode', manifest: expect.objectContaining({ name: 'SpexCode', version: '0.7.0' }) },
      's-there', 'callProgram', { name: 'graph', arguments: { a: 1 } }, false,
    );
    expect(programs.callFromPage).not.toHaveBeenCalled();
    expect(await call(HERE, 'callProgram', { name: 'graph' })).toMatchObject({ ok: true, value: { content: [{ text: 'here' }] } });
    expect(await call(CHAT_PAGE, 'callProgram', { name: 'graph' })).toMatchObject({ ok: true, value: { content: [{ text: 'here' }] } });
    // A page in a chat has no session, so no machine is asked; one of this computer's session is answered here.
    expect(elsewhere.callOnSessionMachine.mock.calls.map(([, sessionId]) => sessionId)).toEqual(['s-there', 's-here']);
  });

  it('a program gugu hosts (Browser Use) runs here even for a page whose session is elsewhere — it drives this screen (161 10-17)', async () => {
    mcp.servers = [{ name: 'browser', host: 'browser-use' }];
    expect(await call(THERE, 'callProgram', { name: 'open', arguments: { url: 'https://x.test' } })).toMatchObject({ ok: true, value: { content: [{ text: 'here' }] } });
    expect(elsewhere.callOnSessionMachine).not.toHaveBeenCalled();
    expect(programs.callFromPage).toHaveBeenCalledWith('spexcode', expect.objectContaining({ name: 'open', from: { sessionId: 's-there' } }));
    // No such host on this computer: refused as the other machine would refuse it.
    programs.callFromPage.mockRejectedValueOnce(new Error('Host capability is unavailable: browser-use'));
    expect(await call(THERE, 'callProgram', { name: 'open' })).toMatchObject({ ok: false, code: 'invalid' });
    // Any other failure of the hosted program here is that failure, not "it runs elsewhere" (追记 4).
    programs.callFromPage.mockRejectedValueOnce(new Error('browserType.launch: Executable doesn\'t exist'));
    expect(await call(HERE, 'callProgram', { name: 'open' })).toMatchObject({ ok: false, code: 'failed', message: expect.stringContaining('browserType.launch') });
  });

  it('a refusal there reaches the page with its code', async () => {
    elsewhere.callOnSessionMachine.mockRejectedValueOnce(Object.assign(new Error('on "server": SpexCode is 0.6.0 on this machine and 0.7.0 where its page is'), { code: 'version-mismatch' }));
    expect(await call(THERE, 'callProgram', { name: 'graph' })).toMatchObject({ ok: false, code: 'version-mismatch' });
  });

  it('its context says the session is on that machine, and gives no path there', async () => {
    const answer = await call(THERE, 'getContext');
    expect(answer).toMatchObject({ ok: true });
    const context = answer.value as { session: Record<string, unknown> };
    expect(context.session).toEqual({ id: 's-there', agentId: 'user:0a000000-0000-4000-8000-0000000000b2', projectId: 'p-there', deviceId: 'dev-server', deviceLabel: 'server' });
    const here = (await call(HERE, 'getContext')).value as { session: Record<string, unknown> };
    expect(here.session).not.toHaveProperty('deviceId');
  });
});

describe('a page\'s data is where its program is (161 10-16「地方决定机器」)', () => {
  it('in a session on another machine it reads and writes that machine\'s data folder; here and in a chat, this computer\'s', async () => {
    expect(await call(THERE, 'readData', { path: 'journal.json' })).toEqual({ ok: true, value: 'there' });
    await call(THERE, 'writeData', { path: 'journal.json', content: '{}' });
    expect(elsewhere.callOnSessionMachine.mock.calls.map(([, sessionId, method, args]) => [sessionId, method, args])).toEqual([
      ['s-there', 'readData', { path: 'journal.json' }],
      ['s-there', 'writeData', { path: 'journal.json', content: '{}' }],
    ]);
    expect(local.read).not.toHaveBeenCalled();
    expect(local.write).not.toHaveBeenCalled();
    expect(await call(HERE, 'readData', { path: 'journal.json' })).toEqual({ ok: true, value: 'here' });
    expect(await call(CHAT_PAGE, 'readData', { path: 'journal.json' })).toEqual({ ok: true, value: 'here' });
    await call(CHAT_PAGE, 'writeData', { path: 'journal.json', content: '{}' });
    expect(local.write).toHaveBeenCalledWith('/data/spexcode', 'journal.json', '{}');
    expect(elsewhere.callOnSessionMachine.mock.calls.map(([, sessionId]) => sessionId)).toEqual(['s-there', 's-there', 's-here']);
  });
});

describe('a program\'s notifications reach the pages of its sessions, wherever they are (owner 10-16)', () => {
  it('a notification here goes to this computer\'s pages and out to the windows connected to this machine — not to a page whose session is elsewhere', () => {
    notified.listener!('spexcode', 'tools', { method: 'notifications/spec/changed', params: { at: 1 } });
    expect(emitted).toEqual([[expect.objectContaining({ name: 'extensions.program.notified' }), { extensionId: 'spexcode', server: 'tools', method: 'notifications/spec/changed', params: { at: 1 } }]]);
    expect(sent.get(HERE)).toEqual([{ type: 'programNotification', server: 'tools', method: 'notifications/spec/changed', params: { at: 1 } }]);
    expect(sent.get(CHAT_PAGE)).toHaveLength(1);
    // 复核 #7300 要改 2: a page drawn in a session on another machine has that machine's program, not this one's.
    expect(sent.get(THERE)).toBeUndefined();
    expect(sent.get(OTHER)).toBeUndefined();
  });

  it('one from another machine reaches only the pages drawn in a session on that machine', async () => {
    await deliverProgramNotificationFrom('dev-server', { extensionId: 'spexcode', server: 'tools', method: 'notifications/spec/changed' });
    expect(sent.get(THERE)).toEqual([{ type: 'programNotification', server: 'tools', method: 'notifications/spec/changed' }]);
    for (const page of [HERE, OTHER, CHAT_PAGE]) expect(sent.get(page)).toBeUndefined();
    await deliverProgramNotificationFrom('dev-server', { extensionId: 'another-app', server: 'tools', method: 'x' });
    expect(sent.get(THERE)).toHaveLength(1);
  });
});
