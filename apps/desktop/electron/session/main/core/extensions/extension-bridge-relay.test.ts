import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F35(10-01)、真源原则 13(10-05):一个 tab 所在的那条会话,连同它的 agent(以 App 认 agent 的那个 id)和项目,
 * 写在 `getContext().session` 里 —— 由 main 按会话自己查,❌ 不由页面所在的聊天栏说;工作副本的路径要
 * `files:*` 才给。
 */

const fakeContents = {
  id: 7,
  isDestroyed: () => false,
  hostWebContents: { id: 42 },
  session: {},
  once: () => undefined,
  on: () => undefined,
  send: () => undefined,
};

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(channel, fn),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => (id === fakeContents.id ? fakeContents : undefined) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'ext.notes',
  isExtensionSessionConfigured: () => true,
}));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    grantedCapabilities: () => ['chat:relay'],
    hasCapability: (_id: string, wanted: string) => wanted === 'chat:relay',
    get: () => ({ manifest: { name: '随手记' } }),
  }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The session the tab is in is named to the App as its agent (F35), and main reads its own facts (真源原则 13).
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ agentIdsBySession: async () => new Map([['task-1', 'user:agent-1']]) }));
const workingCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-relay-'));
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async (id: string) => (id === 'task-1' ? { sessionId: id, projectId: 'proj-1', workspaceRoot: workingCopy } : null),
}));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');

registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const call = (method: string, args: Record<string, unknown>) =>
  handle({ sender: { id: fakeContents.id, session: fakeContents.session } }, { method, args });
beforeEach(async () => {
  setExtensionBridgeHost({
    deliver: () => Promise.resolve(),
    presentation: () => ({ locale: 'zh-CN', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: fakeContents.id, extensionId: 'ext.notes', sessionId: 'task-1', tabId: 'tab-1', tabKind: 'ext.notes.main' });
});

describe('the session a tab is in, told to the App with its agent (F35, 真源原则 13)', () => {
  it('getContext: `session` carries its id, its agent as the user:<uuid> listAgents gives, its project — and no root without files:*', async () => {
    const result = (await call('getContext', {})) as { ok: boolean; value: Record<string, unknown> };
    expect(result.value.session).toEqual({ id: 'task-1', agentId: 'user:agent-1', projectId: 'proj-1' });
    expect(result.value.chat).toBeUndefined();
    expect(result.value.file).toBeUndefined();
  });
});

// Owner 10-14: who works a page is a fact of it, like where — the person on a page the host draws, an agent on its own.
describe('who works the page (owner 10-14)', () => {
  it('getContext: `operator` is the person on a page the host draws, the agent on a page bound for it', async () => {
    const operatorNow = async () => ((await call('getContext', {})) as { value: Record<string, unknown> }).value.operator;
    expect(await operatorNow()).toEqual({ kind: 'person' });
    await bindExtensionSurface({ webContentsId: fakeContents.id, extensionId: 'ext.notes', sessionId: 'task-1', tabId: 'tab-1', tabKind: 'ext.notes.main', operator: { kind: 'agent', id: 'user:agent-1' } });
    expect(await operatorNow()).toEqual({ kind: 'agent', id: 'user:agent-1' });
  });
});
