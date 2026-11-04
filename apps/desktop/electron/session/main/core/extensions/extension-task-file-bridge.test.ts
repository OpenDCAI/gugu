import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAppFiles } from '@shared/extensions/app-files-core';
import { APP_FRAME_MARKER } from '@shared/extensions/app-runtime-protocol';
import { rpcQuery } from '../../../../../../../tests/support/rpcQuery';
import { ExtensionTaskPages, type TaskPageNative } from './extension-task-pages';
import { readTaskFilePayloads } from './task-file-payloads';
import { cancelExtensionSessionCalls } from './extension-program-access';

const ITEM = '11111111-1111-4111-8111-111111111111';
const CHAT = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { getLocale: () => 'en-US' }, ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: () => undefined }, shell: { openExternal: vi.fn() }, clipboard: {} }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('./extension-session', () => ({ extensionIdForSession: () => 'upload-app', isExtensionSessionConfigured: () => true }));
vi.mock('./extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('./extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
vi.mock('./extensions-root', () => ({ extensionsService: () => ({ get: () => ({}), isEnabled: () => true,
  hasCapability: (_id: string, cap: string) => cap === 'agents:tools', grantedCapabilities: () => ['agents:tools'] }) }));
vi.mock('./account-token', async original => ({ ...await original<object>(), currentAccountAccessToken: async () => null }));
vi.mock('./file-sync', () => ({ fileSync: { attachPort: (id: number, extensionId: string) => ({ id, extensionId }),
  fromPort: vi.fn(), pageGone: vi.fn(), revoke: vi.fn(), openCount: () => 0,
  ensureFor: vi.fn(), onPageRelease: vi.fn() }, fileServiceUrl: () => '', localFileService: {} }));
vi.mock('@gugu/core/cloud/supabase', async original => ({ ...await original<object>(), createGuguSupabaseClient: () => ({ rpc: rpcQuery(rpc) }) }));
vi.mock('./task-page-host', () => ({ get extensionTaskPages() { return pages; } }));
const { attachProgramSurface } = await import('./extension-program-surface');

let visible = true;
let readText: () => Promise<string>;
let pages: ExtensionTaskPages;
let surface: ReturnType<typeof attachProgramSurface>;
let child: EventEmitter & { connected: boolean; send: ReturnType<typeof vi.fn> };
let serial = 0;
const row = { id: ITEM, chat_id: CHAT, kind: 'document', filename: 'upload.txt', content_type: 'text/plain',
  size_bytes: 5, version: 2, epoch: 1, pointer: null };
beforeEach(() => {
  visible = true; readText = async () => 'hello'; vi.clearAllMocks();
  rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'chat_facts') return { data: [{ id: CHAT, kind: 'group', source_chat_id: null }], error: null };
    if (args.p_as_user_id !== AGENT || !visible) return { data: null, error: { message: 'no access', hint: 'workspace_item_not_found' } };
    if (name === 'workspace_get_as') return { data: [row], error: null };
    if (name === 'workspace_version_as') return { data: [{ n: 2, inline_text: await readText(), content_type: 'text/plain', pointer: null }], error: null };
    throw new Error(`Unexpected fixture RPC ${name}`);
  });
  const files = createAppFiles({ account: async () => ({ token: 'synthetic', userId: 'person-with-no-group-access' }),
    hasCapability: () => false, sync: { ensureFor: () => {} } as never, identities: async () => [], faces: async () => ({}), filesUrl: () => '', warn: vi.fn() });
  const native: TaskPageNative = { projectId: 'project', title: '', url: 'https://example.org',
    protocol: { attached: false, send: vi.fn(async () => ({})), onMessage: () => () => {}, onClose: () => () => {}, close: vi.fn() },
    setActive: vi.fn(), release: vi.fn() };
  pages = new ExtensionTaskPages(() => {}, async () => native, vi.fn(), (caller, refs, signal) => readTaskFilePayloads(caller, refs, signal, {
    metadata: (page, ref) => files.payloadMetadata({ ...page, itemId: page.handed && 'id' in page.handed ? page.handed.id : null }, { ref }),
    version: (page, ref, n) => files.readVersion({ ...page, itemId: page.handed && 'id' in page.handed ? page.handed.id : null }, { ref, n }),
  }));
  child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
  surface = attachProgramSurface('upload-app', child as unknown as ChildProcess);
});
afterEach(async () => { await surface.close(); });
async function call(method: string, args: unknown, inCall?: string) {
  const id = ++serial;
  child.emit('message', { m: APP_FRAME_MARKER, t: 'call', id, method, args, ...(inCall ? { call: inCall } : {}) });
  await vi.waitFor(() => expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ t: 'result', id })));
  return child.send.mock.calls.map(([frame]) => frame).find(frame => frame.id === id);
}
const hand = (id: string, files = true, task = 'task-a') => surface.hand(id, AGENT,
  files ? [{ itemId: ITEM, chatId: CHAT, agentUserId: AGENT, versions: [2] }] : [], [], task);
async function lease(inCall: string) {
  const answer = await call('taskPageAcquire', { watchId: inCall }, inCall);
  expect(answer).toMatchObject({ ok: true }); return answer.value.id as string;
}

it('uses actual F16 IPC, lease checks and file authority to return only the current call’s card as its agent', async () => {
  const done = hand('a'), id = await lease('a');
  try {
    const answer = await call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, 'a');
    expect(answer).toMatchObject({ ok: true, value: [{ name: 'upload.txt', mimeType: 'text/plain', version: 2 }] });
    expect(new TextDecoder().decode(answer.value[0].bytes)).toBe('hello');
    expect(rpc.mock.calls.filter(([name]) => name === 'workspace_get_as')).toHaveLength(3);
    expect(rpc.mock.calls.filter(([name]) => name.startsWith('workspace_')).every(([, args]) => args.p_as_user_id === AGENT)).toBe(true);
    expect(await call('taskPageSend', { id, method: 'DOM.setFileInputFiles', params: { files: ['/private/fixture'] } }, 'a')).toMatchObject({ ok: false });
  } finally { await done(); }
});

it('never borrows A’s grant for a parallel call, a background frame, a person or an unknown call ID', async () => {
  const doneA = hand('a'), doneB = hand('b', false), id = await lease('a');
  try {
    for (const inCall of ['b', undefined, 'forged']) {
      rpc.mockClear();
      expect(await call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, inCall)).toMatchObject({ ok: false });
      expect(rpc).not.toHaveBeenCalled();
    }
    const donePerson = surface.hand('person', null, [], [], 'task-a', 'person');
    try { expect(await call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, 'person')).toMatchObject({ ok: false }); }
    finally { await donePerson(); }
  } finally { await doneA(); await doneB(); }
});

it('cancel A promptly rejects its pending upload, does not close the shared lease or affect B, and fences its late bytes', async () => {
  const doneA = hand('a'), doneB = hand('b'), id = await lease('a');
  const held = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>();
  readText = () => { entered.resolve(); return held.promise; };
  const a = call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, 'a');
  await entered.promise; await doneA();
  expect(await a).toMatchObject({ ok: false });
  readText = async () => 'hello';
  expect(await call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, 'b')).toMatchObject({ ok: true });
  held.resolve('hello'); await Promise.resolve(); await doneB();
});

it('task Stop and permission loss fence output after a download started', async () => {
  for (const stop of [() => { visible = false; }, () => cancelExtensionSessionCalls('task-a')]) {
    const done = hand('active'), id = await lease('active');
    const held = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>();
    readText = () => { entered.resolve(); return held.promise; };
    const result = call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, 'active');
    await entered.promise; stop(); held.resolve('hello');
    expect(await result).toMatchObject({ ok: false });
    visible = true; await done();
  }
});

it('releasing the actual IPC page lease replies to a pending upload before the file service returns', async () => {
  const done = hand('held'), id = await lease('held');
  const held = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>();
  readText = () => { entered.resolve(); return held.promise; };
  const resultId = serial + 1, result = call('taskPageFilePayloads', { id, refs: [{ file: ITEM }] }, 'held');
  try {
    await entered.promise;
    expect(await call('taskPageRelease', { id }, 'held')).toMatchObject({ ok: true });
    await new Promise(resolve => setImmediate(resolve));
    const reply = child.send.mock.calls.map(([frame]) => frame).find(frame => frame.t === 'result' && frame.id === resultId);
    expect(reply).toMatchObject({ ok: false });
    cancelExtensionSessionCalls('task-a');
  } finally { held.resolve('hello'); await result; await done(); }
});
