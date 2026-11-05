import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cloudFileProviders } from '@gugu/core/cloud/fileProviders';
import { createCachedFileSink, type FileChunkCache } from '@gugu/core/shared/fileCache';
import { createFileResolver, type FileRevision } from '@gugu/core/shared/fileResolver';
import { setCoreLoggerFactory } from '../../../../../../../packages/core/src/log';
import type { FilesPlatform } from '@shared/extensions/app-files-core';
import { until } from '../../../../../../../tests/support/awaitCondition';
// vi.waitFor gives up after 1 s by default: under a loaded full run the dispatch below takes longer and the case
// went red (and its late call leaked into the next case). Wait for the fact itself; see tests/support/awaitCondition.ts.

const ITEM = '44444444-4444-4444-8444-444444444444';
const CHAT = '33333333-3333-4333-8333-333333333333';
let resolveFile: NonNullable<FilesPlatform['resolveFile']>;
let readError: unknown;

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
    fromPort: vi.fn(), pageGone: vi.fn(), revoke: vi.fn(), pageFor: (id: number, extensionId: string) => ({ id, extensionId }), openCount: () => 0, ensureFor: vi.fn() },
  fileServiceUrl: () => 'http://files.invalid', localFileService: {},
}));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@shared/extensions/app-files-core', async original => {
  const actual = await original<typeof import('@shared/extensions/app-files-core')>();
  return { ...actual, createAppFiles: (platform: FilesPlatform) => {
    const files = actual.createAppFiles({ ...platform, account: async () => ({ token: 'fixture', userId: 'owner' }), resolveFile: (...args) => resolveFile(...args) });
    return { ...files, open: async (...args: Parameters<typeof files.open>) => {
      try { return await files.open(...args); } catch (error) { readError = error; throw error; }
    }, read: async (...args: Parameters<typeof files.read>) => {
      try { return await files.read(...args); } catch (error) { readError = error; throw error; }
    } };
  } };
});

const { attachProgramSurface } = await import('./extension-program-surface');
const { APP_FRAME_MARKER } = await import('@shared/extensions/app-runtime-protocol');

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('R3 program lifetime reaches the existing byte recovery', () => {
  it('k4 releases an actual files.read during backoff without another fetch', async () => {
    const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
    const surface = attachProgramSurface('reader', child as unknown as ChildProcess);
    const chunks = new Map<number, Uint8Array>();
    const cache: FileChunkCache = {
      get: async (_key, index) => chunks.get(index) ?? null,
      put: async (_key, index, value) => { chunks.set(index, value); }, clear: async () => { chunks.clear(); },
    };
    const revision: FileRevision = {
      source: 'local', item_id: ITEM, version: 1, chat_id: CHAT, file_name: 'file.bin',
      content_type: 'application/octet-stream', size_bytes: 1, sha256: 'ab'.repeat(32),
      host_account_id: 'owner', host_device_id: 'device', host_project_id: 'project', relative_path: 'file.bin',
      workspace: { path: 'file.bin', parent_id: null, created_at: null, updated_at: null, created_by: 'owner', source_message_ids: [] },
    };
    const fetcher = vi.fn(async (): Promise<Response> => { throw new TypeError('fetch failed'); });
    const cloud = cloudFileProviders({ cache, sink: async size => createCachedFileSink(cache, size), fetch: fetcher,
      endpoint: async () => ({ supabaseUrl: 'https://api.invalid', anonKey: 'anon', token: 'fixture', fetch: async () =>
        Response.json({ status: 'ready', url: 'https://objects.invalid/file', download_id: 'lease', sha256: revision.sha256, size_bytes: 1 }) }),
    });
    const resolve = createFileResolver({ ...cloud,
      local: async context => ({ revision, open: () => cloud.managed(revision, context) }), ssh: async () => null,
    });
    resolveFile = async (ref, actor, options) => resolve({ item_id: 'id' in ref ? ref.id : ITEM }, { accountId: 'owner', actorId: actor ?? 'owner' }, options);
    const warnings: unknown[] = [];
    const restoreLog = setCoreLoggerFactory(() => ({ debug() {}, info() {}, error() {}, warn(fields) { warnings.push(fields); } }));
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); readError = undefined;
    const release = surface.hand('call-1', 'agent', [{ itemId: ITEM, chatId: CHAT, agentUserId: 'agent' }]);
    try {
      child.emit('message', { m: APP_FRAME_MARKER, t: 'call', id: 43, call: 'call-1', method: 'filesOpen', args: { ref: { id: ITEM } } });
      await until(`result 43 is sent`, () => child.send.mock.calls.some(([frame]) => frame?.t === 'result' && frame.id === 43));
      expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'result', id: 43, ok: true }));
      child.emit('message', { m: APP_FRAME_MARKER, t: 'call', id: 44, call: 'call-1', method: 'filesRead', args: { ref: { id: ITEM, version: 1 }, offset: 0, length: 1 } });
      await until('the byte fetch starts', () => fetcher.mock.calls.length > 0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await release();
      const warningCount = warnings.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveLength(warningCount);
      expect(readError).toMatchObject({ name: 'AbortError' });
      expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'result', id: 44, ok: false }));
    } finally { await surface.close(); restoreLog(); }
  });
});
