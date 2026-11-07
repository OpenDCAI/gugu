import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalAppFiles, createLocalFileService, type LocalSurface } from './local-files';
import { readWorkingCopy } from './working-copy-files';
import { createWorkspaceUploads, readWorkspaceChunk } from '../files/workspace-transfer';
import { createFileChunkCache, createFileSink } from '@gugu/core/local/files/fileSnapshots';
import { privatePasswordVaultDirectory } from '@gugu/core/local/state/protectedPrivateStorage';
import { packExtensionArchive } from './extension-archive';
import { importProjectFile } from '../../../../projectFileImport';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('./app-files', () => ({ localRootOf: async () => ({ workspaceRoot: fixture.root }) }));
let root: string;
let secret: string;
let surface: LocalSurface;
let service: ReturnType<typeof createLocalFileService>;
let files: ReturnType<typeof createLocalAppFiles>;
const canary = 'synthetic-protected-app-file';
const privateBytes = Buffer.from(canary + '\0');

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-private-app-')));
  fixture.root = root;
  vi.stubEnv('GUGU_HOME', path.join(root, 'host-state'));
  fs.mkdirSync(privatePasswordVaultDirectory(), { recursive: true });
  secret = path.join(privatePasswordVaultDirectory(), 'vault.png');
  fs.writeFileSync(secret, privateBytes);
  surface = { pageId: 1, extensionId: 'file-app', place: { workspace: 'session:private-test' }, workspaceRoot: root, filePath: null };
  service = createLocalFileService({ warn: vi.fn() });
  files = createLocalAppFiles({
    service, hasCapability: () => true, self: async () => ({ userId: 'owner', name: 'Owner' }),
    sync: { ensureFor: vi.fn(), pageFor: vi.fn(), grant: vi.fn(), ungrant: vi.fn(), revoke: vi.fn() },
  });
});
afterEach(async () => {
  await service.closeAll();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['open', 'download', 'create', 'rename', 'replace', 'remove', 'upload', 'open target'])('refuses App %s when the working copy contains a private root', async action => {
  const id = path.relative(root, secret).split(path.sep).join('/');
  const ref = { workspace: surface.place.workspace, id };
  const upload = { name: 'new.bin', contentType: 'application/octet-stream', bytes: new Uint8Array([1, 2]).buffer };
  const attempt = (): unknown => {
    if (action === 'open') return files.open(surface, { ref });
    if (action === 'download') return files.downloadSource(surface, { ref });
    if (action === 'create') return files.create(surface, { name: id + '.new', content: 'altered' });
    if (action === 'rename') return files.rename(surface, { ref, name: 'moved.bin' });
    if (action === 'replace') return files.replace(surface, { ref, file: upload });
    if (action === 'remove') return files.remove(surface, { ref });
    if (action === 'upload') return files.upload(surface, [{ ...upload, name: id + '.new' }]);
    return files.openTarget(surface, { ref });
  };
  await expect(Promise.resolve().then(attempt)).rejects.toThrow();
  expect(fs.readFileSync(secret)).toEqual(privateBytes);
  expect(fs.existsSync(secret + '.new')).toBe(false);
});

it('refuses App chunk reads and workspace transfers of private bytes and missing control files', async () => {
  const relative = path.relative(root, secret);
  await expect(readWorkingCopy(surface.place, relative, 0, 100)).rejects.toThrow();
  await expect(readWorkspaceChunk(root, { path: relative, offset: 0, length: 100 })).rejects.toThrow();
  const flag = path.join(privatePasswordVaultDirectory(), 'switch.json');
  const uploads = createWorkspaceUploads();
  await expect(uploads.write(root, { path: path.relative(root, flag), uploadId: 'private', offset: 0,
      data: Buffer.from('altered').toString('base64'), total: 7, final: true, expectedEtag: null })).rejects.toThrow();
  expect(fs.existsSync(flag)).toBe(false);
});

it('refuses hard-link aliases in an otherwise ordinary App working copy', async () => {
  const ordinary = path.join(root, 'ordinary');
  fs.mkdirSync(ordinary);
  fs.linkSync(secret, path.join(ordinary, 'alias.bin'));
  const fileSurface = { ...surface, workspaceRoot: ordinary };
  await expect(files.downloadSource(fileSurface, { ref: { workspace: surface.place.workspace, id: 'alias.bin' } })).rejects.toThrow();
  await expect(readWorkspaceChunk(ordinary, { path: 'alias.bin', offset: 0, length: 100 })).rejects.toThrow();
});

it('does not let snapshot caches or exports write into a protected tree', async () => {
  const cache = createFileChunkCache(privatePasswordVaultDirectory());
  await expect(cache.put('a'.repeat(64), 0, Buffer.from('altered'))).rejects.toThrow();
  const destination = path.join(privatePasswordVaultDirectory(), 'export.bin');
  await expect((async () => {
    const sink = await createFileSink(path.join(root, 'staging'), canary.length, destination);
    try { await sink.write(Buffer.from(canary)); await sink.commit(); }
    finally { await sink.abort(); }
  })()).rejects.toThrow();
  expect(fs.existsSync(destination)).toBe(false);
});

it('refuses an archive source containing protected storage before inspecting or reading the bundle', async () => {
  const inspectDirectory = vi.fn(() => { throw new Error('must not inspect private state'); });
  await expect(packExtensionArchive({ inspectDirectory }, root)).rejects.toThrow();
  expect(inspectDirectory).not.toHaveBeenCalled();
});

it('preserves ordinary App file creation and chunk reads', async () => {
  const ordinary = path.join(root, 'ordinary');
  fs.mkdirSync(ordinary);
  const opened = await files.create({ ...surface, workspaceRoot: ordinary }, { name: 'allowed.txt', content: 'ordinary' });
  expect(opened.id).toBe('allowed.txt');
  const chunk = await readWorkspaceChunk(ordinary, { path: 'allowed.txt', offset: 0, length: 100 });
  expect(Buffer.from(chunk.data, 'base64').toString()).toBe('ordinary');
  expect(createHash('sha256').update(fs.readFileSync(secret)).digest('hex')).toBe(createHash('sha256').update(privateBytes).digest('hex'));
});

it('refuses project import of a protected source before hashing or creating a shared copy', async () => {
  const ordinary = path.join(root, 'ordinary');
  fs.mkdirSync(ordinary);
  const find = vi.fn(async () => null);
  await expect(importProjectFile(ordinary, { path: secret, name: 'copied.bin', size: privateBytes.length }, find)).rejects.toThrow();
  expect(find).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(ordinary, '.gugu'))).toBe(false);
});
