import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { FileHandle } from '@gugu/core/shared/fileResolver';
import type { FilesPlatform } from '@shared/extensions/app-files-core';

const ITEM = '44444444-4444-4444-8444-444444444444';
const CHAT = '33333333-3333-4333-8333-333333333333';
let resolveFile: NonNullable<FilesPlatform['resolveFile']>;
let readError: unknown;
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
    return { ...files, open: async (...args: Parameters<typeof files.open>) => {
      try { return await files.open(...args); } catch (error) { readError = error; throw error; }
    }, read: async (...args: Parameters<typeof files.read>) => {
      try { return await files.read(...args); } catch (error) { readError = error; throw error; }
    } };
  } };
});


vi.mock('@gugu/core/cloud/supabase', async original => ({ ...await original<object>(),
  createGuguSupabaseClient: () => ({ rpc }),
}));

const { attachProgramSurface } = await import('./extension-program-surface');
const { APP_FRAME_MARKER } = await import('@shared/extensions/app-runtime-protocol');

beforeEach(() => { vi.clearAllMocks(); readError = undefined; });
afterEach(() => { vi.restoreAllMocks(); });

describe('resource lookup preserves a dispatched program call', () => {
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
      await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'result', id })));
      return child.send.mock.calls.map(([frame]) => frame).find(frame => frame.id === id);
    };
    try {
      emit(51, state === 'unscoped' ? undefined : 'person-a');
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('chat_facts', { p_chat_id: CHAT, p_as_user_id: 'owner' }));
      expect(heldFiles.readHandleCount()).toBe(0);
      expect(resolve).not.toHaveBeenCalled(); expect(byteRead).not.toHaveBeenCalled();
      if (state !== 'active') await releaseA();
      lookup.resolve(result);
      if (state === 'ended') {
        expect(await answer(51)).toMatchObject({ ok: false });
        expect(readError).toMatchObject({ name: 'AbortError' });
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

