import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from '@gugu/core/shared/fileResolver';
import type { FilesPlatform } from '@shared/extensions/app-files-core';
import { until } from '../../../../../../../tests/support/awaitCondition';
// vi.waitFor gives up after 1 s by default: under a loaded full run the dispatch below takes longer and the case
// went red (and its late call leaked into the next case). Wait for the fact itself; see tests/support/awaitCondition.ts.

const ITEM = '44444444-4444-4444-8444-444444444444';
const CHAT = '33333333-3333-4333-8333-333333333333';
let resolveFile: NonNullable<FilesPlatform['resolveFile']>;
let heldFiles: ReturnType<typeof import('@shared/extensions/app-files-core').createAppFiles>;
const byteRead = vi.fn(async () => new Uint8Array([3, 4]));
const rpc = vi.hoisted(() => vi.fn());
const released = new Set<(pageId: number) => void>();

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' }, BrowserWindow: {}, dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() }, webContents: { fromId: () => undefined },
  shell: { openExternal: vi.fn() }, clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'reader', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('./projection-task', () => ({ projectionTaskProject: async () => 'project' }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({
  get: () => ({}), list: () => ({ extensions: [] }), openWithDefaults: () => ({}),
  isEnabled: () => true, hasCapability: () => true, grantedCapabilities: () => ['files:read'],
}) }));
vi.mock('@main/core/extensions/account-token', async original => ({ ...await original<object>(), currentAccountAccessToken: async () => null }));
vi.mock('@main/core/extensions/file-sync', () => ({
  fileSync: { attachPort: (id: number, extensionId: string) => ({ id, extensionId }),
    fromPort: vi.fn(), pageGone: (pageId: number) => { for (const listener of released) listener(pageId); },
    onPageRelease: (listener: (pageId: number) => void) => { released.add(listener); }, revoke: vi.fn(), pageFor: (id: number, extensionId: string) => ({ id, extensionId }), openCount: () => 0, ensureFor: vi.fn() },
  fileServiceUrl: () => 'http://files.invalid', localFileService: {},
}));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@shared/extensions/app-files-core', async original => {
  const actual = await original<typeof import('@shared/extensions/app-files-core')>();
  return { ...actual, createAppFiles: (platform: FilesPlatform) => {
    const files = actual.createAppFiles({ ...platform, account: async () => ({ token: 'fixture', userId: 'owner' }), resolveFile: (...args) => resolveFile(...args) });
    heldFiles = files;
    return files;
  } };
});


vi.mock('@gugu/core/cloud/supabase', async original => ({ ...await original<object>(),
  createGuguSupabaseClient: () => ({ rpc }),
}));

const { attachProgramSurface } = await import('./extension-program-surface');
const { APP_FRAME_MARKER } = await import('@shared/extensions/app-runtime-protocol');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('resource lookup preserves a dispatched program call', () => {
  it.each([
    ['filesRename', 'ended'], ['filesRename', 'active'], ['filesRename', 'unscoped'],
    ['filesMove', 'ended'], ['filesMove', 'active'], ['filesMove', 'unscoped'],
  ] as const)('a delayed %s stays %s', async (method, state) => {
    const agent = '55555555-5555-4555-8555-555555555555';
    const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
    const surface = attachProgramSurface('reader', child as unknown as ChildProcess);
    const handed = [{ chatId: CHAT, itemId: ITEM, agentUserId: agent }];
    const releaseA = surface.hand('agent-a', agent, handed);
    const releaseB = surface.hand('agent-b', agent, handed);
    const lookup = Promise.withResolvers<{ data: { id: string; kind: string; source_chat_id: null }[]; error: null }>();
    const chat = { data: [{ id: CHAT, kind: 'group', source_chat_id: null }], error: null };
    const row = { id: ITEM, chat_id: CHAT, kind: 'file', filename: 'before.bin', content_type: 'application/octet-stream',
      size_bytes: 2, created_at: null, updated_at: null, created_by: null, updated_by: null, source_message_ids: [],
      pointer: null, version: 1, epoch: 1, parent_id: null, system_role: null, path: 'before.bin' };
    let firstLookup = true;
    rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'chat_facts') {
        if (firstLookup) { firstLookup = false; return lookup.promise; }
        return Promise.resolve(chat);
      }
      if (name === 'workspace_get_as') return { select: async () => ({ data: [row], error: null }) };
      if (name === 'workspace_move_as') return Promise.resolve({ data: [{ ...row, filename: args.p_name, path: args.p_name }], error: null });
      throw new Error(`Unexpected fixture RPC ${name}`);
    });
    const emit = (id: number, call?: string) => child.emit('message', {
      m: APP_FRAME_MARKER, t: 'call', id, ...(call ? { call } : {}), method,
      args: { ref: { id: ITEM, chat: CHAT }, name: 'after.bin' },
    });
    const answer = async (id: number) => {
      await until(`result ${id} is sent`, () => child.send.mock.calls.some(([frame]) => frame?.t === 'result' && frame.id === id));
      return child.send.mock.calls.map(([frame]) => frame).find(frame => frame.id === id);
    };
    const mutations = () => rpc.mock.calls.filter(([name]) => name === 'workspace_move_as');
    try {
      emit(61, state === 'unscoped' ? undefined : 'agent-a');
      await until('the chat lookup is dispatched', () => rpc.mock.calls.some(([name]) => name === 'chat_facts'));
      expect(rpc).toHaveBeenCalledWith('chat_facts', { p_chat_id: CHAT, p_as_user_id: state === 'unscoped' ? 'owner' : agent });
      expect(mutations()).toEqual([]);
      if (state !== 'active') await releaseA();
      lookup.resolve(chat);
      if (state !== 'ended') {
        expect(await answer(61)).toMatchObject({ ok: true, value: { id: ITEM, name: 'after.bin' } });
        expect(mutations()).toHaveLength(1);
        expect(mutations()[0]?.[1]).toMatchObject({ p_item_id: ITEM, p_as_user_id: state === 'active' ? agent : 'owner', p_name: 'after.bin' });
        return;
      }
      expect(await answer(61)).toMatchObject({ ok: false });
      expect(mutations()).toEqual([]);
      expect(byteRead).not.toHaveBeenCalled();
      // B has the same actor and handed file, but remains an independent, live call.
      emit(62, 'agent-b');
      expect(await answer(62)).toMatchObject({ ok: true, value: { id: ITEM, name: 'after.bin' } });
      expect(mutations()).toHaveLength(1);
      expect(mutations()[0]?.[1]).toMatchObject({ p_item_id: ITEM, p_as_user_id: agent, p_name: 'after.bin' });
      // Ending A must not turn an ordinary, unscoped operation into an ended call.
      emit(63);
      expect(await answer(63)).toMatchObject({ ok: true, value: { id: ITEM, name: 'after.bin' } });
      expect(mutations()).toHaveLength(2);
      expect(mutations()[1]?.[1]).toMatchObject({ p_as_user_id: 'owner' });
    } finally { lookup.resolve(chat); await releaseA(); await releaseB(); await surface.close(); }
  });

  it.each(['ended', 'active', 'unscoped'] as const)('a person read delayed in actual chat resolution stays %s', async state => {
    const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
    const surface = attachProgramSurface('reader', child as unknown as ChildProcess);
    const releaseA = surface.hand('person-a', null, [], [], 'person-task', 'person');
    const releaseB = surface.hand('person-b', null, [], [], 'person-task', 'person');
    const lookup = Promise.withResolvers<{ data: { id: string; kind: string; source_chat_id: null }[]; error: null }>();
    const result = { data: [{ id: CHAT, kind: 'group', source_chat_id: null }], error: null };
    rpc.mockImplementationOnce(() => lookup.promise).mockResolvedValue(result);
    const resolve = vi.fn<NonNullable<FilesPlatform['resolveFile']>>(async (_ref, actor, options) => ({
      status: 'ready', purpose: 'file', reader: { accountId: 'owner', actorId: actor ?? 'owner' },
      revision: { source: 'local', item_id: ITEM, version: options.version, chat_id: CHAT, size_bytes: 2,
        file_name: 'data.bin', content_type: 'application/octet-stream', sha256: null },
      read: byteRead, stream: async function* () { yield new Uint8Array([3, 4]); }, dispose: async () => {},
    } satisfies FileHandle));
    resolveFile = resolve;
    const emit = (id: number, call?: string) => child.emit('message', {
      m: APP_FRAME_MARKER, t: 'call', id, ...(call ? { call } : {}), method: 'filesRead',
      args: { ref: { id: ITEM, chat: CHAT, version: 1 }, offset: 0, length: 2 },
    });
    const answer = async (id: number) => {
      await until(`result ${id} is sent`, () => child.send.mock.calls.some(([frame]) => frame?.t === 'result' && frame.id === id));
      return child.send.mock.calls.map(([frame]) => frame).find(frame => frame.id === id);
    };
    try {
      emit(51, state === 'unscoped' ? undefined : 'person-a');
      await until('the chat lookup is dispatched', () => rpc.mock.calls.some(([name]) => name === 'chat_facts'));
      expect(rpc).toHaveBeenCalledWith('chat_facts', { p_chat_id: CHAT, p_as_user_id: 'owner' });
      expect(heldFiles.readHandleCount()).toBe(0);
      expect(resolve).not.toHaveBeenCalled(); expect(byteRead).not.toHaveBeenCalled();
      if (state !== 'active') await releaseA();
      lookup.resolve(result);
      if (state === 'ended') {
        expect(await answer(51)).toMatchObject({ ok: false, code: 'failed', message: 'This operation was aborted' });
        expect(resolve).not.toHaveBeenCalled(); expect(byteRead).not.toHaveBeenCalled();
        expect(heldFiles.readHandleCount()).toBe(0);
        // The other call stays active after A's delayed lookup is refused.
        emit(52, 'person-b');
        expect(await answer(52)).toMatchObject({ ok: true, value: { data: new Uint8Array([3, 4]) } });
        expect(resolve.mock.calls[0]?.[2].signal?.aborted).toBe(false);
      } else {
        expect(await answer(51)).toMatchObject({ ok: true, value: { data: new Uint8Array([3, 4]) } });
        expect(byteRead).toHaveBeenCalledTimes(1);
        expect(resolve.mock.calls[0]?.[2].signal?.aborted).toBe(state === 'active' ? false : undefined);
      }
    } finally { lookup.resolve(result); await releaseA(); await releaseB(); await surface.close(); }
  });
});

