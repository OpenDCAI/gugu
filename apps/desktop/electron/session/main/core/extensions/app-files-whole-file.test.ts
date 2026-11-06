import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ capabilities: new Set<string>(), machine: vi.fn(async () => null as { deviceId: string; projectId: string | null } | null), remote: vi.fn(), root: '' }));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ hasCapability: (_app: string, cap: string) => f.capabilities.has(cap), get: () => ({ manifest: { id: 'reader' } }) }) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: {}, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ sessionMachine: f.machine, callOnSessionMachine: f.remote }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async () => ({ workspaceRoot: f.root, projectId: 'p', workspaceId: 'w' }) }));
vi.mock('@main/core/files/file-tree/projector', () => ({ FileTreeProjector: class {} }));

const { appFileExists, readAppFile, readAppFileText, openAppFile } = await import('./app-files');

const workspace = 'session:11111111-1111-4111-8111-111111111111';
let outside = '';
const page = (handed: unknown = null) => ({ pageId: 3, extensionId: 'reader', handed }) as never;

beforeEach(async () => {
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
});

it('says a file with a NUL in it is binary, and over the limit only sizes it', async () => {
  f.capabilities.add('files:read');
  await fsp.writeFile(path.join(f.root, 'a.bin'), Buffer.from([1, 0, 2]));
  expect(await readAppFileText(page(), { ref: { workspace, id: 'a.bin' } })).toMatchObject({ binary: true, content: '' });
  expect(await readAppFileText(page(), { ref: { workspace, id: 'conf.json' }, maxBytes: 4 })).toMatchObject({ truncated: true, content: '', totalSize: 19 });
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
  await expect(readAppFileText(page(), { ref: { workspace, id: `../${path.basename(outside)}/notes.md` } })).rejects.toBeDefined();
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
