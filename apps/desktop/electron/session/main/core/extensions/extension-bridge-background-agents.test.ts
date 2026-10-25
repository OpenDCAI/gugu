import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L12: the background page sees and drives agents as every page does (真源原则 13: where a page is only fills its
 * context) — the narrow tiers reach the agents this extension started, `:all` every one. A keep-warmer is work that goes
 * on with no page open. Agents are named by their `user:<uuid>` (F35); the session behind each stays in gugu.
 * The counter-cells: without the capability it is refused, and a verb about a page itself is not the background page's.
 */

const TAB = 7;
const BACKGROUND = 9;
const MINE = 'user:0a000000-0000-4000-8000-0000000000b2';
const LANE_A = 'user:0a000000-0000-4000-8000-0000000000a1';
const contentsOf = (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined });

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => (id === TAB || id === BACKGROUND ? contentsOf(id) : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'keeper',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extension-background', () => ({
  extensionBackgroundWebContentsId: () => BACKGROUND,
  runningExtensionBackgrounds: () => [['keeper', BACKGROUND]],
}));
const granted = new Set<string>();
// 宽窄的判法用真的(manifest.ts 那两个纯函数),只把「授了哪些词」换成假的。
vi.mock('@main/core/extensions/extensions-root', async () => {
  const { capabilityCovered, grantedReach } = await import('@shared/extensions/manifest');
  return {
    extensionsService: () => ({
      grantedCapabilities: () => [...granted],
      hasCapability: (_id: string, wanted: string) => capabilityCovered([...granted], wanted),
      agentReach: (_id: string, family: string) => grantedReach([...granted], family),
      get: () => ({ manifest: { name: 'Keeper' } }),
    }),
  };
});

/** The scope filter, standing in for the conversation read: `own` is only the agent this extension started. */
const visibleAgentsForExtension = vi.fn(async (options: { scope: 'own' | 'all' | 'all-machines' }) =>
  new Map(options.scope !== 'own' ? [[MINE, 'conv-mine'], [LANE_A, 'conv-lane-a']] : [[MINE, 'conv-mine']]),
);
/** The listing; with `:all-machines` the other computers' rows come with it, and one computer was not read. */
const listAgentsForExtension = vi.fn(async (options: { scope: 'own' | 'all' | 'all-machines' }) => ({
  agents: [
    ...[...(await visibleAgentsForExtension(options)).keys()].map((agentId) => ({ agentId })),
    ...(options.scope === 'all-machines' ? [{ agentId: 'user:on-b', deviceId: 'dev-b', deviceLabel: 'ThinkPad' }] : []),
  ],
  unreached: options.scope === 'all-machines' ? [{ deviceId: 'dev-c', label: 'Old Mac', detail: 'did not answer' }] : [],
}));
const stopAgentForExtension = vi.fn(async (options: { agentId: string; visibleAgents: Map<string, string> }) => {
  // As extension-agents.ts refuses it: `not-found`, the same code as messageAgent's for an agent it does not reach.
  if (!options.visibleAgents.has(options.agentId)) throw Object.assign(new Error(`No agent "${options.agentId}" is visible to this App`), { code: 'not-found' });
});
vi.mock('@main/core/extensions/extension-agents', () => ({
  visibleAgentsForExtension: (options: { scope: 'own' | 'all' | 'all-machines' }) => visibleAgentsForExtension(options),
  listAgentsForExtension: (options: { scope: 'own' | 'all' | 'all-machines' }) => listAgentsForExtension(options),
  stopAgentForExtension: (options: { agentId: string; visibleAgents: Map<string, string> }) => stopAgentForExtension(options),
}));
const dispatchForApp = vi.fn(async () => ({ to: { agent: LANE_A }, id: 'm-1' }));
vi.mock('@main/core/extensions/extension-send', () => ({
  dispatchForApp: (...args: unknown[]) => dispatchForApp(...(args as [])),
}));
const warn = vi.fn();
vi.mock('@main/lib/logger', () => ({ log: { warn: (...args: unknown[]) => warn(...args), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (sender: number, method: string, args: Record<string, unknown> = {}) =>
  handle({ sender: { id: sender, session: {} } }, { method, args });

beforeEach(async () => {
  granted.clear();
  visibleAgentsForExtension.mockClear();
  listAgentsForExtension.mockClear();
  stopAgentForExtension.mockClear();
  dispatchForApp.mockClear();
  warn.mockClear();
  await bindExtensionSurface({ webContentsId: TAB, extensionId: 'keeper', sessionId: 'task-1', tabId: 'tab-1', tabKind: 'keeper.main' });
});

describe('the background page lists agents as every page does (L12)', () => {
  it('agents:read — the ones it started; :all — every one; named by user:<uuid>', async () => {
    granted.add('agents:read');
    expect(await call(BACKGROUND, 'listAgents')).toEqual({ ok: true, value: [{ agentId: MINE }] });
    expect(listAgentsForExtension).toHaveBeenLastCalledWith({ scope: 'own', extensionId: 'keeper' });
    granted.add('agents:read:all');
    expect(await call(BACKGROUND, 'listAgents')).toEqual({ ok: true, value: [{ agentId: MINE }, { agentId: LANE_A }] });
  });

  // Control (the parent commit a770f2e40d): the tab answered for its session too — `user:task-agent` was among them.
  it('a tab of the same App in a session gets the same answer: where the page is plays no part', async () => {
    granted.add('agents:read');
    expect(await call(TAB, 'listAgents')).toEqual({ ok: true, value: [{ agentId: MINE }] });
    expect(listAgentsForExtension).toHaveBeenLastCalledWith({ scope: 'own', extensionId: 'keeper' });
  });

  // `:all` 是这台电脑;`:all-machines` 的清单里还有别的电脑的行。没读到的那台记一条,❌ 静默。
  it('agents:read:all-machines lists with that reach; a computer that was not read is logged', async () => {
    granted.add('agents:read:all');
    await call(BACKGROUND, 'listAgents');
    expect(listAgentsForExtension).toHaveBeenLastCalledWith({ scope: 'all', extensionId: 'keeper' });
    granted.clear();
    granted.add('agents:read:all-machines');
    expect(await call(BACKGROUND, 'listAgents')).toEqual({
      ok: true,
      value: [{ agentId: MINE }, { agentId: LANE_A }, { agentId: 'user:on-b', deviceId: 'dev-b', deviceLabel: 'ThinkPad' }],
    });
    expect(listAgentsForExtension).toHaveBeenLastCalledWith({ scope: 'all-machines', extensionId: 'keeper' });
    expect(warn).toHaveBeenCalledWith('listAgents: another machine was not read', expect.objectContaining({ deviceId: 'dev-c' }));
  });

  it('counter-cell: without agents:read it is refused, and nothing is read', async () => {
    expect(await call(BACKGROUND, 'listAgents')).toEqual({ ok: false, code: 'denied', message: 'Not permitted: this App does not have "agents:read"' });
    expect(listAgentsForExtension).not.toHaveBeenCalled();
  });
});

describe('the background page drives the agents it may see', () => {
  it('dispatch to an agent it names: told directly — the door asked for agents:control; no target is a page\'s (its sheet)', async () => {
    expect(await call(BACKGROUND, 'dispatch', { to: { agent: LANE_A }, text: 'keep warm' })).toEqual({
      ok: false,
      code: 'denied',
      message: 'Not permitted: this App does not have "agents:control"',
    });
    granted.add('agents:control:all');
    expect(await call(BACKGROUND, 'dispatch', { to: { agent: LANE_A }, text: 'keep warm' })).toEqual({ ok: true, value: { to: { agent: LANE_A }, id: 'm-1' } });
    expect(dispatchForApp).toHaveBeenCalledWith('keeper', { to: { agent: LANE_A }, text: 'keep warm' }, { chat: null, session: null }, expect.objectContaining({ pick: expect.any(Function) }));
    // The background page has no gesture, so never the sheet.
    expect(await call(BACKGROUND, 'dispatch', { text: 'keep warm' })).toMatchObject({ ok: false, code: 'denied', message: expect.stringContaining('gesture') });
  });

  it('stopAgent by user:<uuid>; the narrow tier does not reach an agent it did not start', async () => {
    granted.add('agents:control');
    expect(await call(BACKGROUND, 'stopAgent', { agentId: LANE_A })).toMatchObject({ ok: false, code: 'not-found' });
    expect(await call(BACKGROUND, 'stopAgent', { agentId: MINE })).toEqual({ ok: true, value: undefined });
    expect(stopAgentForExtension).toHaveBeenCalledTimes(2);
    expect(await call(BACKGROUND, 'sendToAgent', { agentId: MINE, text: 'x' })).toMatchObject({ ok: false });
  });

  it('stopAgent with :all-machines: an agent not on this computer is refused as such, nothing is stopped', async () => {
    granted.add('agents:control:all-machines');
    expect(await call(BACKGROUND, 'stopAgent', { agentId: 'user:on-b' })).toMatchObject({
      ok: false,
      code: 'failed',
      message: expect.stringContaining('stopAgent acts only here'),
    });
    expect(stopAgentForExtension).not.toHaveBeenCalled();
    expect(await call(BACKGROUND, 'stopAgent', { agentId: LANE_A })).toEqual({ ok: true, value: undefined });
  });

  it('counter-cell: a verb about a page itself is not the background page\'s; broadcastToViews is not a page\'s', async () => {
    expect(await call(BACKGROUND, 'setTabTitle', { title: 'x' })).toEqual({ ok: false, code: 'invalid', message: "setTabTitle is a page's; the background page has none" });
    expect(await call(BACKGROUND, 'compose', { text: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(TAB, 'broadcastToViews', { message: 'x' })).toEqual({ ok: false, code: 'invalid', message: "broadcastToViews is the background page's; a page has none" });
    // Control: the background page's own.
    expect(await call(BACKGROUND, 'broadcastToViews', { message: 'x' })).toEqual({ ok: true, value: { delivered: 1 } });
  });
});
