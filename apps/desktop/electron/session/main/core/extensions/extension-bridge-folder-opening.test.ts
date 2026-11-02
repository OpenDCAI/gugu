import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { until } from '../../../../../../../tests/support/awaitCondition';

const fixture = vi.hoisted(() => ({
  chat: '0b000000-0000-4000-8000-000000000021',
  person: '0a000000-0000-4000-8000-000000000021',
  agent: '0a000000-0000-4000-8000-000000000022',
  apiVersion: 26,
  held: false,
  failList: false,
  routes: [] as { route: string; args: Record<string, unknown> }[],
  waiting: [] as (() => void)[],
  pickedMembers: [] as unknown[][],
}));
const handlers = vi.hoisted(() => new Map<string, (event: unknown, request: unknown) => Promise<unknown>>());
const sent: { type: string; context?: { chat?: { members?: unknown[] } } }[] = [];
const contents = { id: 21, session: {}, hostWebContents: null, isDestroyed: () => false, once: () => undefined, on: () => undefined,
  send: (_channel: string, event: (typeof sent)[number]) => sent.push(event) };

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler), on: vi.fn() },
  webContents: { fromId: (id: number) => id === 21 ? contents : undefined }, BrowserWindow: {}, dialog: {},
  app: { getPath: () => process.env.TMPDIR!, getName: () => 'folder-test' },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({
  get: () => ({ manifest: { id: 'workspace', name: 'Folder', apiVersion: fixture.apiVersion, contributes: { tabs: [{ name: 'main' }] } } }),
  grantedCapabilities: () => ['files:read'], hasCapability: () => true, isEnabled: () => true,
  list: () => ({ extensions: [] }), openWithDefaults: () => ({}),
}) }));
vi.mock('@main/core/extensions/account-token', async (original) => ({
  ...await original<object>(),
  currentAccountAccessToken: async () => `h.${Buffer.from(JSON.stringify({ sub: fixture.person })).toString('base64url')}.s`,
}));
vi.mock('@main/core/extensions/file-sync', () => ({
  fileSync: { ensureFor: () => undefined, revoke: () => undefined, pageGone: () => undefined },
  fileServiceUrl: () => 'https://files.invalid', localFileService: {},
}));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@main/core/extensions/extension-bridge-relay', () => ({ drawMemberFaces: async () => ({}), pickDispatchTarget: async (_embedder: unknown, ask: { chat: { members: unknown[] } }) => {
  fixture.pickedMembers.push(ask.chat.members);
  return null;
} }));
vi.mock('@main/core/extensions/extension-agents', () => ({ visibleAgentsForExtension: async () => new Map(), spawnAgentForExtension: vi.fn() }));
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => {
  const read = async (route: string, args: Record<string, unknown>) => {
    fixture.routes.push({ route, args });
    if (fixture.held) await new Promise<void>((resolve) => fixture.waiting.push(resolve));
    if (route === 'rpc/chat_facts') return { data: [{ id: fixture.chat, kind: 'group', source_chat_id: null }], error: null };
    if (route === 'rpc/list_member_ids') return { data: [{ user_id: fixture.person }], error: null };
    if (route === 'rpc/workspace_list_as') return fixture.failList
      ? { data: null, error: { message: 'list-offline', code: 'XX021' } }
      : { data: [{ id: '0f000000-0000-4000-8000-000000000021', chat_id: fixture.chat, kind: 'document', filename: 'notes.md',
        content_type: 'text/markdown', version: 1, created_by: fixture.person, parent_id: null, path: 'notes.md', total: 1 }], error: null };
    if (route === 'chats') return { data: { id: fixture.chat, kind: 'group', name: 'Group', source_chat_id: null }, error: null };
    if (route === 'users') return { data: [{ id: fixture.person, display_name: 'Reader', avatar: null, type: 'human', owner_user_id: null }], error: null };
    if (route === 'user_settings') return { data: null, error: null };
    throw new Error(`Unexpected route: ${route}`);
  };
  return {
    rpc: (name: string, args: Record<string, unknown>) => {
      const result = read(`rpc/${name}`, args);
      return Object.assign(result, { select: () => result });
    },
    from: (table: string) => {
      const args: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { args[column] = value; return query; },
        in: (column: string, value: unknown) => { args[column] = value; return query; },
        maybeSingle: () => read(table, args),
        then: (resolve: (value: unknown) => void, reject: (error: unknown) => void) => read(table, args).then(resolve, reject),
      };
      return query;
    },
  };
} }));

const bridge = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
bridge.registerExtensionBridge();
const call = (method: string, args: Record<string, unknown> = {}, gesture = false) => handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: contents }, { method, args, gesture });
const place = () => ({ chat: fixture.chat });
const bind = (agent = false) => bridge.bindExtensionSurface({ webContentsId: 21, extensionId: 'workspace', tabId: 'folder', tabKind: 'workspace.main',
  conversation: fixture.chat, ...{ resourceChat: fixture.chat }, ...(agent ? { operator: { kind: 'agent' as const, id: `user:${fixture.agent}` } } : {}) });
const routeNames = () => fixture.routes.map(({ route }) => route);
// One release means one network wave. setImmediate drains the real promise/import work without a wall-clock assertion.
const finish = async <T>(work: Promise<T>): Promise<{ result: T; waves: string[][] }> => {
  let done = false;
  const settled = work.finally(() => { done = true; });
  const waves: string[][] = [];
  let observed = 0;
  for (let turn = 0; !done && turn < 10; turn += 1) {
    await until('the next controlled request or the completed opening', () => done || fixture.waiting.length > 0);
    await setImmediate();
    if (fixture.waiting.length) {
      waves.push(routeNames().slice(observed));
      observed = fixture.routes.length;
      for (const release of fixture.waiting.splice(0)) release();
    }
  }
  expect(done, 'all controlled requests settled').toBe(true);
  return { result: await settled, waves };
};
beforeEach(async () => {
  fixture.apiVersion = 26; fixture.held = false; fixture.failList = false; fixture.routes.length = 0; fixture.waiting.length = 0; sent.length = 0;
  fixture.pickedMembers.length = 0;
  await bridge.chatMembersChanged(fixture.chat, [{ memberId: fixture.agent, left: true }]);
  bridge.setExtensionBridgeHost({ deliver: async () => undefined, presentation: () => ({ locale: 'en', themeMode: 'light', fullscreen: false, windowFocused: true }) });
});
afterEach(() => bridge.unbindExtensionSurface(21));

describe('opening the folder: API compatibility and one-use preloads', () => {
  it('p1: context then list and preferences finish in at most two controlled waves without reading members', async () => {
    fixture.held = true;
    const { result, waves } = await finish((async () => {
      await bind();
      const context = await call('getContext');
      const files = await Promise.all([call('filesList', { place: place() }), call('filesViewPreferences', { place: place() })]);
      return { context, files };
    })());
    expect(result.context).toMatchObject({ ok: true, value: { chat: { id: fixture.chat } } });
    expect(result.files.every((answer) => (answer as { ok: boolean }).ok)).toBe(true);
    expect(waves.length, JSON.stringify(waves)).toBeLessThanOrEqual(2);
    expect(routeNames().sort()).toEqual(['chats', 'rpc/workspace_list_as', 'user_settings', 'users'].sort());
  });

  it('p2: a second list reads afresh', async () => {
    await bind(); await call('getContext');
    await call('filesList', { place: place() });
    fixture.routes.length = 0;
    expect(await call('filesList', { place: place() })).toMatchObject({ ok: true });
    expect(routeNames().filter((route) => route === 'rpc/workspace_list_as')).toEqual(['rpc/workspace_list_as']);
  });

  it('p3: API 25 includes members in its first answer', async () => {
    fixture.apiVersion = 25;
    await bind();
    expect(await call('getContext')).toMatchObject({ ok: true, value: { chat: { members: [{ id: `user:${fixture.person}` }] } } });
    expect(routeNames()).toContain('rpc/list_member_ids');
  });

  it('p4: API 26 omits members and still supports the explicit members call', async () => {
    await bind();
    const context = await call('getContext') as { value: { chat: Record<string, unknown> } };
    expect(context.value.chat).not.toHaveProperty('members');
    expect(routeNames()).not.toContain('rpc/list_member_ids');
    expect(await call('chatsMembers', { chat: fixture.chat })).toMatchObject({ ok: true, value: { members: [{ id: `user:${fixture.person}` }] } });
  });

  it('p5: a failed preloaded list is delivered once without another request', async () => {
    fixture.failList = true;
    await bind(); await call('getContext');
    const before = routeNames().filter((route) => route === 'rpc/workspace_list_as');
    expect(before).toHaveLength(1);
    expect(await call('filesList', { place: place() })).toMatchObject({ ok: false, message: 'list-offline' });
    expect(routeNames().filter((route) => route === 'rpc/workspace_list_as')).toHaveLength(1);
  });

  it('p6: an agent page lists as that agent, never as the person', async () => {
    await bind(true); await call('getContext'); await call('filesList', { place: place() });
    const reads = fixture.routes.filter(({ route }) => route === 'rpc/workspace_list_as');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.args.p_as_user_id).toBe(fixture.agent);
    expect(fixture.routes.find(({ route }) => route === 'rpc/chat_facts')?.args.p_as_user_id).toBe(fixture.agent);
  });

  it('a different first folder consumes no preload, and the next root read is fresh too', async () => {
    await bind(); await call('getContext');
    await call('filesList', { place: place(), folder: 'nested' });
    await call('filesList', { place: place() });
    const reads = fixture.routes.filter(({ route }) => route === 'rpc/workspace_list_as');
    expect(reads).toHaveLength(3);
    expect(reads.map(({ args }) => args.p_folder)).toEqual([undefined, 'nested', undefined]);
  });

  it('a file revision discards a preload before the first list', async () => {
    await bind(); await call('getContext');
    await bridge.notifyGroupWorkspaceChanged([{ chatId: fixture.chat, itemIds: [] }]);
    await call('filesList', { place: place() });
    expect(routeNames().filter((route) => route === 'rpc/workspace_list_as')).toHaveLength(2);
  });

  it('API 26 does not receive roster-change context or trigger another members read', async () => {
    await bind(); await call('getContext');
    sent.length = 0; fixture.routes.length = 0;
    await bridge.chatMembersChanged(fixture.chat, [{ memberId: fixture.agent, left: false }]);
    expect(sent.filter(({ type }) => type === 'context')).toEqual([]);
    expect(routeNames()).toEqual([]);
  });

  it('an API 26 dispatch picker reads its members once when opened', async () => {
    await bind(); await call('getContext');
    fixture.routes.length = 0;
    expect(await call('dispatch', { text: 'Hello' }, true)).toMatchObject({ ok: true });
    expect(routeNames().filter((route) => route === 'rpc/list_member_ids')).toEqual(['rpc/list_member_ids']);
    expect(fixture.pickedMembers).toEqual([[]]); // The signed-in person remains excluded by the shared dispatch path.
  });
});
