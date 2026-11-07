import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ capabilities: new Set<string>(), machine: vi.fn(async () => null as { deviceId: string; projectId: string | null } | null), remote: vi.fn(), root: '' }));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/lib/events', () => {
  const listeners = new Map<unknown, Set<(data: unknown) => void>>();
  return { events: {
    on: (channel: unknown, handler: (data: unknown) => void) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(handler); return () => listeners.get(channel)!.delete(handler); },
    emit: (channel: unknown, data: unknown) => { for (const handler of listeners.get(channel) ?? []) handler(data); },
  } };
});
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ hasCapability: (_app: string, cap: string) => f.capabilities.has(cap), get: () => ({ manifest: { id: 'reader' } }) }) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: {}, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ sessionMachine: f.machine, callOnSessionMachine: f.remote }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async () => ({ workspaceRoot: f.root, projectId: 'p', workspaceId: 'w' }) }));
vi.mock('@main/core/files/file-tree/projector', () => ({ FileTreeProjector: class {} }));

const { appFileExists, readAppFile, readAppFileText, openAppFile, writeAppFileChunk, writeAppFileText, watchAppFile } = await import('./app-files');
const { releaseWorkingCopies } = await import('./working-copy-files');

const workspace = 'session:11111111-1111-4111-8111-111111111111';
let outside = '';
const page = (handed: unknown = null) => ({ pageId: 3, extensionId: 'reader', handed }) as never;

beforeEach(async () => {
  releaseWorkingCopies(3);
  f.capabilities.clear();
  vi.clearAllMocks();
  f.machine.mockResolvedValue(null);
  f.root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'whole-file-root-')));
  outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'whole-file-out-')));
  await fsp.writeFile(path.join(f.root, 'conf.json'), '// comment\n{"x":1}\n');
  await fsp.writeFile(path.join(outside, 'notes.md'), '# outside');
});

afterEach(async () => {
  await fsp.rm(f.root, { recursive: true, force: true });
  await fsp.rm(outside, { recursive: true, force: true });
});

it('reads a text no live document holds, whole', async () => {
  f.capabilities.add('files:read');
  const read = await readAppFileText(page(), { ref: { workspace, id: 'conf.json' } });
  expect(read).toMatchObject({ content: '// comment\n{"x":1}\n', truncated: false, totalSize: 19 });
  expect(read.binary).toBeUndefined();
  expect(read.exact).toBe(true);
});

it('says a file with a NUL in it is binary, and over the limit only sizes it', async () => {
  f.capabilities.add('files:read');
  await fsp.writeFile(path.join(f.root, 'a.bin'), Buffer.from([1, 0, 2]));
  expect(await readAppFileText(page(), { ref: { workspace, id: 'a.bin' } })).toMatchObject({ binary: true, content: '' });
  expect(await readAppFileText(page(), { ref: { workspace, id: 'conf.json' }, maxBytes: 4 })).toMatchObject({ truncated: true, content: '', totalSize: 19 });
});

it('reads a file whose name says nothing by its bytes, and believes a name that says something else', async () => {
  f.capabilities.add('files:read');
  for (const name of ['Makefile', '.env', '.gitignore', 'a.vue', 'yarn.lock']) {
    await fsp.writeFile(path.join(f.root, name), 'all: x\n');
    expect(await readAppFileText(page(), { ref: { workspace, id: name } }), name).toMatchObject({ content: 'all: x\n', exact: true });
  }
  await fsp.writeFile(path.join(f.root, 'a.png'), 'looks like text');
  expect(await readAppFileText(page(), { ref: { workspace, id: 'a.png' } })).toMatchObject({ binary: true, content: '' });
  await fsp.writeFile(path.join(f.root, 'noname'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  expect(await readAppFileText(page(), { ref: { workspace, id: 'noname' } })).toMatchObject({ binary: true });
});

it('says text in another encoding is not exact', async () => {
  f.capabilities.add('files:read');
  await fsp.writeFile(path.join(f.root, 'gbk.md'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  expect(await readAppFileText(page(), { ref: { workspace, id: 'gbk.md' } })).toMatchObject({ content: '中文', exact: false });
});

it('says how far it has read, to whoever asked by a transfer id', async () => {
  f.capabilities.add('files:read');
  await fsp.writeFile(path.join(f.root, 'long.txt'), 'x'.repeat(200 * 1024));
  const heard: [string, number, number][] = [];
  await readAppFileText(page(), { ref: { workspace, id: 'long.txt' }, transferId: 't' }, (...said) => heard.push(said));
  expect(heard.length).toBeGreaterThan(1);
  expect(heard.at(-1)).toEqual(['t', 200 * 1024, 200 * 1024]);
  heard.length = 0;
  await readAppFileText(page(), { ref: { workspace, id: 'long.txt' } }, (...said) => heard.push(said));
  expect(heard).toEqual([]);
});

it('reads across pieces', async () => {
  f.capabilities.add('files:read');
  const long = 'é'.repeat(400 * 1024);
  await fsp.writeFile(path.join(f.root, 'long.txt'), long);
  expect((await readAppFileText(page(), { ref: { workspace, id: 'long.txt' } })).content).toBe(long);
});

it('the file the host handed needs no capability, whether clicked or restored: the tab names it', async () => {
  const ref = { workspace, id: path.join(outside, 'notes.md') };
  expect((await readAppFileText(page(ref), { ref })).content).toBe('# outside');
  expect(await appFileExists(page(ref), { ref })).toBe(true);
});

it('an absolute path reaches nothing but the handed file, whatever the capabilities', async () => {
  f.capabilities.add('files:read');
  f.capabilities.add('files:write');
  const ref = { workspace, id: path.join(outside, 'notes.md') };
  for (const handed of [null, { workspace, id: path.join(outside, 'other.md') }, { workspace: 'session:22222222-2222-4222-8222-222222222222', id: ref.id }]) {
    await expect(readAppFileText(page(handed), { ref })).rejects.toMatchObject({ code: 'denied' });
    await expect(appFileExists(page(handed), { ref })).rejects.toMatchObject({ code: 'denied' });
    await expect(readAppFile(page(handed), { ref, offset: 0, length: 1 })).rejects.toMatchObject({ code: 'denied' });
    await expect(openAppFile(page(handed), { ref })).rejects.toMatchObject({ code: 'denied' });
  }
});

it('another file of the working copy needs files:read', async () => {
  await expect(readAppFileText(page(), { ref: { workspace, id: 'conf.json' } })).rejects.toMatchObject({ code: 'denied' });
});

it('a relative path cannot climb out of the working copy', async () => {
  f.capabilities.add('files:read');
  await expect(readAppFileText(page(), { ref: { workspace, id: `../${path.basename(outside)}/notes.md` } })).rejects.toThrow('path is outside this workspace: ');
});

it('says a file is gone', async () => {
  f.capabilities.add('files:read');
  expect(await appFileExists(page(), { ref: { workspace, id: 'gone.md' } })).toBe(false);
  await expect(readAppFileText(page(), { ref: { workspace, id: 'gone.md' } })).rejects.toMatchObject({ code: 'not-found' });
});

it('another machine is asked, for its pieces', async () => {
  f.capabilities.add('files:read');
  f.capabilities.add('files:read:all-machines');
  f.machine.mockResolvedValue({ deviceId: 'there', projectId: null });
  f.remote.mockResolvedValue({ there: true, value: { size: 2, etag: 'e', offset: 0, data: 'aGk=' } });
  expect((await readAppFileText(page(), { ref: { workspace, id: 'a.md' } })).content).toBe('hi');
  expect(f.remote).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'filesRead', expect.objectContaining({ ref: { workspace, id: 'a.md' } }), false);
});

const onDisk = (name: string) => fsp.readFile(path.join(f.root, name), 'utf8');

it('saves over the version it read, and again over what it saved', async () => {
  f.capabilities.add('files:read');
  f.capabilities.add('files:write');
  const ref = { workspace, id: 'conf.json' };
  await readAppFileText(page(), { ref });
  await writeAppFileText(page(), { ref, text: 'one' });
  expect(await onDisk('conf.json')).toBe('one');
  await writeAppFileText(page(), { ref, text: 'two' });
  expect(await onDisk('conf.json')).toBe('two');
});

it('refuses to save over a change it never read, and leaves the disk as it is', async () => {
  f.capabilities.add('files:read');
  f.capabilities.add('files:write');
  const ref = { workspace, id: 'conf.json' };
  await readAppFileText(page(), { ref });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fsp.writeFile(path.join(f.root, 'conf.json'), 'theirs, longer');
  await expect(writeAppFileText(page(), { ref, text: 'mine' })).rejects.toMatchObject({ code: 'content-changed' });
  expect(await onDisk('conf.json')).toBe('theirs, longer');
  expect((await readAppFileText(page(), { ref })).content).toBe('theirs, longer');
  await writeAppFileText(page(), { ref, text: 'merged' });
  expect(await onDisk('conf.json')).toBe('merged');
});

it('makes a file deleted since it was read again', async () => {
  f.capabilities.add('files:read');
  f.capabilities.add('files:write');
  const ref = { workspace, id: 'conf.json' };
  await readAppFileText(page(), { ref });
  await fsp.rm(path.join(f.root, 'conf.json'));
  await writeAppFileText(page(), { ref, text: 'back' });
  expect(await onDisk('conf.json')).toBe('back');
});

it('will not write over a file it never read', async () => {
  f.capabilities.add('files:write');
  releaseWorkingCopies(3);
  await expect(writeAppFileText(page(), { ref: { workspace, id: 'conf.json' }, text: 'x' })).rejects.toMatchObject({ code: 'content-changed' });
  await writeAppFileText(page(), { ref: { workspace, id: 'new/made.txt' }, text: 'new' });
  expect(await onDisk('new/made.txt')).toBe('new');
});

it('writes the handed file outside the working copy, and no other, whatever the capabilities', async () => {
  const file = path.join(outside, 'notes.md');
  const ref = { workspace, id: file };
  await readAppFileText(page(ref), { ref });
  await writeAppFileText(page(ref), { ref, text: 'saved' });
  expect(await fsp.readFile(file, 'utf8')).toBe('saved');
  f.capabilities.add('files:write');
  await expect(writeAppFileText(page(), { ref, text: 'no' })).rejects.toMatchObject({ code: 'denied' });
  await expect(writeAppFileChunk(page(), { place: { workspace }, path: file, uploadId: 'u', offset: 0, data: 'bm8=', total: 2, final: true, expectedEtag: 'force' })).rejects.toMatchObject({ code: 'denied' });
  expect(await fsp.readFile(file, 'utf8')).toBe('saved');
});

it('hears a file on another machine through the window, which has that machine\'s events', async () => {
  f.capabilities.add('files:read');
  f.capabilities.add('files:read:all-machines');
  f.machine.mockResolvedValue({ deviceId: 'there', projectId: null });
  const { events } = await import('@main/lib/events');
  const { appFileHeardElsewhereChannel, appFileWatchElsewhereChannel } = await import('@shared/events/appEvents');
  const asked: ({ key: string; sessionId: string; on: boolean } & ({ file: string } | { folder: string }))[] = [];
  const off = events.on(appFileWatchElsewhereChannel, (request) => asked.push(request));
  const heard: unknown[] = [];
  const stop = await watchAppFile(page(), { workspace, id: 'a.md' }, (change) => heard.push(change));
  expect(asked).toEqual([expect.objectContaining({ file: 'a.md', on: true, sessionId: '11111111-1111-4111-8111-111111111111' })]);
  events.emit(appFileHeardElsewhereChannel, { key: asked[0]!.key, change: { kind: 'resync' } });
  expect(heard).toEqual([{ kind: 'resync' }]);
  stop();
  expect(asked.at(-1)).toMatchObject({ key: asked[0]!.key, on: false });
  events.emit(appFileHeardElsewhereChannel, { key: asked[0]!.key, change: { kind: 'resync' } });
  expect(heard.length).toBe(1);
  off();
});

it('on the machine a file is on: a relative path stays in the working copy, reading and writing', async () => {
  const { machineVerbs } = await import('./machine-verbs');
  const climb = `../${path.basename(outside)}/notes.md`;
  await expect(machineVerbs.filesRead('reader', { ref: { workspace, id: climb }, offset: 0, length: 10 })).rejects.toThrow('path is outside this workspace: ');
  await expect(machineVerbs.filesWriteChunk('reader', { place: { workspace }, path: climb, uploadId: 'c', offset: 0, data: 'bm8=', total: 2, final: true, expectedEtag: 'force' })).rejects.toThrow(`${climb} is outside this working copy`);
  expect(await fsp.readFile(path.join(outside, 'notes.md'), 'utf8')).toBe('# outside');
});
