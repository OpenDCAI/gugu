import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { APP_FILE_MAX_BYTES } from '@shared/extensions/app-runtime-protocol';
import { EXTENSION_API_VERSION, capabilityCovered } from '@shared/extensions/manifest';

/**
 * `gugu.files` on a session of the person's other machine, read only. The machine that has the session answers a chunk
 * inside that working copy, with a working copy's codes and never its own absolute path; the asking machine finds the
 * session in the other machines' lists, puts the chunks together, and passes that machine's refusal on as it came.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-files-elsewhere-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'app-files-elsewhere-out-'));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
const clip = Buffer.alloc(REMOTE_WORKSPACE_CHUNK_BYTES * 2 + 77);
for (let i = 0; i < clip.length; i += 1) clip[i] = (i * 31) % 251;
fs.mkdirSync(path.join(root, 'renders'));
fs.writeFileSync(path.join(root, 'renders', 'cut.mp4'), clip);
fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));

let granted: string[] = [];
const appReadFile = vi.fn();
const sessionsElsewhere = vi.fn();
const saveDialog = vi.fn(async () => ({ canceled: true }));
const logged = vi.hoisted(() => ({ info: [] as unknown[][] }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, dialog: { showSaveDialog: saveDialog } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined, error: () => undefined, info: (...args: unknown[]) => logged.info.push(args) } }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    hasCapability: (_id: string, wanted: string) => capabilityCovered(granted, wanted),
    get: () => ({ manifest: { name: '片场' } }),
    list: () => ({ extensions: [] }),
    isEnabled: () => true,
    openWithDefaults: () => ({}),
  }),
}));
vi.mock('@main/core/extensions/account-token', async (importOriginal) => ({ ...(await importOriginal<object>()), currentAccountAccessToken: async () => null }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, fileServiceUrl: () => 'http://files.invalid', localFileService: {} }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: () => null }));
vi.mock('@shared/extensions/app-files-core', async (original) => ({
  ...(await original<typeof import('@shared/extensions/app-files-core')>()),
  createAppFiles: () => ({ self: async () => ({ userId: 'user:0a000000-0000-4000-8000-0000000000c1', name: 'Person' }) }),
}));
const local = new Proxy({}, { get: (_t, verb) => () => Promise.reject(new Error(`local ${String(verb)} reached`)) });
vi.mock('@main/core/extensions/local-files', () => ({ createLocalAppFiles: () => local }));
// This computer has two sessions: one open, one whose working copy is not open. Anything else is not here.
vi.mock('@main/core/extensions/extension-agent-context', () => ({
  agentSessionContext: async (sessionId: string) =>
    sessionId === 's-here' ? { sessionId, projectId: 'p-1', workspaceRoot: root } : sessionId === 's-closed' ? { sessionId, projectId: 'p-1', workspaceRoot: null } : null,
}));
vi.mock('@main/core/extensions/extension-agents', () => ({ sessionsElsewhere }));
vi.mock('@main/core/sessions/session-family', () => ({ otherMachines: () => ({ appReadFile }) }));
const { answerAppReadFile } = await import('./app-files-elsewhere');
const files = await import('./app-files');

const CALLER = { kind: 'app', deviceId: 'dev-a', deviceLabel: 'this box', extensionId: 'studio', extensionName: '片场' } as const;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const ask = (sessionId: string, rel: string, offset = 0) =>
  answerAppReadFile(CALLER, { action: 'read_file', session_id: sessionId, path: rel, offset, length: REMOTE_WORKSPACE_CHUNK_BYTES });
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));

describe('the machine that has the session answers a chunk', () => {
  it('reads inside the working copy and names the file by the path it was asked for, once in the log', async () => {
    logged.info.length = 0;
    await ask('s-here', 'renders/cut.mp4');
    const chunk = await ask('s-here', 'renders/cut.mp4', REMOTE_WORKSPACE_CHUNK_BYTES);
    expect(chunk).toMatchObject({ path: 'renders/cut.mp4', size: clip.length, offset: REMOTE_WORKSPACE_CHUNK_BYTES });
    expect(Buffer.from(chunk.data, 'base64')).toEqual(clip.subarray(REMOTE_WORKSPACE_CHUNK_BYTES, REMOTE_WORKSPACE_CHUNK_BYTES * 2));
    expect(JSON.stringify(chunk)).not.toContain(root);
    expect(logged.info).toEqual([
      ['[app-files] a file read for an App on another machine', { device: 'dev-a', app: 'studio', session: 's-here', path: 'renders/cut.mp4', size: clip.length }],
    ]);
  });

  it.each([
    ['s-elsewhere', 'a.txt', 'not-found', 'Session s-elsewhere has no working copy open on its machine'],
    ['s-closed', 'a.txt', 'not-found', 'Session s-closed has no working copy open on its machine'],
    ['s-here', path.join(outside, 'secret.txt'), 'invalid', 'Say which file by its path in the working copy'],
    ['s-here', '../secret.txt', 'not-found', 'No file "../secret.txt" in that working copy'],
    ['s-here', 'link-out.txt', 'not-found', 'No file "link-out.txt" in that working copy'],
    ['s-here', 'renders/none.mp4', 'not-found', 'No file "renders/none.mp4" in that working copy'],
    ['s-here', 'renders', 'invalid', 'renders is not a file'],
  ])('%s %s: %s, in the words of a working copy here', async (sessionId, rel, code, message) => {
    expect(await refusal(ask(sessionId, rel))).toEqual({ code, message });
  });
});

const page = { pageId: 1, extensionId: 'studio', handed: null };
const far = { session: 's-far', name: 'renders/cut.mp4' };
const listed = (rows: Array<{ id: string; deviceId: string }>, unreached: Array<{ label: string }> = []) =>
  sessionsElsewhere.mockResolvedValue({ rows: rows.map(({ id, deviceId }) => ({ session: { conversationId: id }, deviceId, deviceLabel: 'studio' })), unreached });
/** The other machine: chunks of `bytes`, each with the etag given for it (the first one when no more are given). */
const serving = (bytes: Buffer, etags = ['e1']) => {
  let n = 0;
  appReadFile.mockImplementation(async (_app: unknown, _device: string, { path: rel, offset, length }: { path: string; offset: number; length: number }) => {
    const etag = etags[Math.min(n, etags.length - 1)];
    n += 1;
    return { path: rel, size: bytes.length, etag, offset, data: bytes.subarray(offset, offset + length).toString('base64') };
  });
};

beforeEach(() => {
  appReadFile.mockReset();
  sessionsElsewhere.mockReset();
  saveDialog.mockClear();
  listed([{ id: 's-far', deviceId: 'dev-b' }]);
  serving(clip);
});

describe("another machine's session: the door is files:read:all-machines", () => {
  it('an App granted only the word has files:read among its granted words — what the bridge and the file events check', async () => {
    const { ExtensionsService } = await import('./extensions-service');
    const source = path.join(outside, 'board');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'index.html'), '');
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
      id: 'board',
      name: 'Board',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION,
      platforms: ['desktop'],
      entry: 'index.html',
      permissions: { capabilities: ['files:read:all-machines'] },
      contributes: { tabs: [{ name: 'main', title: 'Board' }] },
    }));
    const service = new ExtensionsService(path.join(outside, 'installed'));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder');
    expect(service.grantedCapabilities('board')).toEqual(['files:read', 'files:read:all-machines']);
  });

  it('without the word, and for a session here, the working copy here answers as before: nothing is asked elsewhere', async () => {
    granted = ['files:read', 'files:write'];
    expect(await refusal(files.openAppFile(page, { ref: far }))).toMatchObject({ code: 'not-found' });
    expect(await refusal(files.downloadAppFile(page, { ref: far }, null))).toMatchObject({ code: 'not-found' });
    granted = ['files:read:all-machines'];
    expect(await refusal(files.openAppFile(page, { ref: { session: 's-closed', name: 'a.md' } }))).toMatchObject({ code: 'not-found' });
    expect(await refusal(files.openAppFile(page, { ref: { session: 's-here', name: 'a.md' } }))).toMatchObject({ message: 'local open reached' });
    expect(sessionsElsewhere).not.toHaveBeenCalled();
    expect(appReadFile).not.toHaveBeenCalled();
  });

  it('with the word: a clip over several chunks, byte for byte and read only, asked of the machine that lists it as this App', async () => {
    granted = ['files:read:all-machines'];
    const opened = await files.openAppFile(page, { ref: far });
    expect(opened).toMatchObject({
      access: 'ro',
      docName: '',
      entry: { id: 'renders/cut.mp4', session: 's-far', name: 'cut.mp4', contentType: 'video/mp4', type: 'binary', size: clip.length, version: null },
    });
    expect(sha(new Uint8Array(opened.bytes!))).toBe(sha(clip));
    expect(appReadFile).toHaveBeenCalledTimes(3);
    expect(appReadFile).toHaveBeenCalledWith({ extensionId: 'studio', extensionName: '片场' }, 'dev-b', {
      action: 'read_file',
      session_id: 's-far',
      path: 'renders/cut.mp4',
      offset: 0,
      length: REMOTE_WORKSPACE_CHUNK_BYTES,
    });
    // Saving reads it the same way, before the save dialog shows.
    expect(await files.downloadAppFile(page, { ref: far }, null)).toBe(false);
    expect(appReadFile).toHaveBeenCalledTimes(6);
    expect(saveDialog).toHaveBeenCalledTimes(1);
  });

  const refusedThere = Object.assign(new Error('on "studio" (device:dev-b): No file "renders/cut.mp4" in that working copy'), { code: 'not-found' });
  /** What the cross-machine layer says when the read never reached that working copy: its own code, an agent's sentence. */
  const onTheWay = (code: string) => Object.assign(new Error('"studio" did not answer — check with session_get / session_children before repeating it'), { code });
  it.each([
    ['listed nowhere, every machine read', () => listed([]), 0, { code: 'not-found', message: 'Session s-far is not on this computer or on your other online computers' }],
    ['listed nowhere, a machine not read', () => listed([], [{ label: 'studio' }]), 0, { code: 'failed', message: 'Session s-far is not on this computer or on your other online computers (not read: studio)' }],
    ["over an open file's size", () => appReadFile.mockResolvedValue({ path: 'x', size: APP_FILE_MAX_BYTES + 1, etag: 'e', offset: 0, data: '' }), 1, { code: 'too-large' }],
    ['changing while read', () => serving(clip, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']), 6, { code: 'failed', message: 'renders/cut.mp4 kept changing while it was read; open it again when it is written' }],
    ['refused there', () => appReadFile.mockRejectedValue(refusedThere), 1, { code: 'not-found', message: refusedThere.message }],
    ['too old there', () => appReadFile.mockRejectedValue(onTheWay('SESSION_DEVICE_OUTDATED')), 1, { code: 'failed', message: 'Could not read renders/cut.mp4 from "studio" (SESSION_DEVICE_OUTDATED)' }],
    ['no answer there', () => appReadFile.mockRejectedValue(onTheWay('SESSION_DEVICE_NO_ANSWER')), 1, { code: 'failed', message: 'Could not read renders/cut.mp4 from "studio" (SESSION_DEVICE_NO_ANSWER)' }],
  ])('%s: %i chunks asked, then said to the page', async (_case, arrange, reads, said) => {
    granted = ['files:read:all-machines'];
    arrange();
    expect(await refusal(files.openAppFile(page, { ref: far }))).toMatchObject(said);
    expect(appReadFile).toHaveBeenCalledTimes(reads);
  });
});
