import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  capabilities: new Set<string>(),
  machine: vi.fn(async () => null as { deviceId: string; projectId: string | null } | null),
  remote: vi.fn(),
  root: '',
  shown: [] as string[],
  dialogDir: '',
  dialogFile: '',
  openIn: vi.fn(async () => undefined),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [f.dialogDir] }), showSaveDialog: async () => ({ canceled: false, filePath: f.dialogFile }) },
  shell: { showItemInFolder: (p: string) => f.shown.push(p) },
}));
vi.mock('@main/lib/events', () => {
  const listeners = new Map<unknown, Set<(data: unknown) => void>>();
  return { events: {
    on: (channel: unknown, handler: (data: unknown) => void) => { if (!listeners.has(channel)) listeners.set(channel, new Set()); listeners.get(channel)!.add(handler); return () => listeners.get(channel)!.delete(handler); },
    emit: (channel: unknown, data: unknown) => { for (const handler of listeners.get(channel) ?? []) handler(data); },
  } };
});
vi.mock('@main/core/app/service', () => ({ appService: { openIn: f.openIn } }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({ hasCapability: (_app: string, cap: string) => f.capabilities.has(cap), get: () => ({ manifest: { id: 'reader' } }) }) }));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: vi.fn(), resolveAccountFile: vi.fn(), publishAccountFile: vi.fn() }));
vi.mock('@main/core/extensions/file-sync', () => ({ fileSync: {}, localFileService: { removed() {}, renamed() {} }, fileServiceUrl: vi.fn() }));
vi.mock('@main/core/extensions/extension-icon', () => ({ renderExtensionIcon: vi.fn() }));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ sessionMachine: f.machine, callOnSessionMachine: f.remote }));
vi.mock('@main/core/extensions/extension-agent-context', () => ({ agentSessionContext: async () => ({ workspaceRoot: f.root, projectId: 'p', workspaceId: 'w' }) }));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: { acquire: async () => ({ value: { git: { openWorktree: async () => { throw new Error('no git'); } } }, release: async () => undefined }) } }));
vi.mock('@main/core/workspaces/workspace-runtime', () => ({
  acquireWorkspaceRuntime: async (_r: unknown, workDir: string) => {
    const { FileTree } = await import('../../../../../../../packages/session-core/src/files/tree/file-tree');
    const watcher = { nudge: async () => false, watch: () => ({ ready: async () => {}, release: async () => {} }) };
    const fileTree = new (FileTree as never as new (o: unknown) => { ready(): Promise<unknown> })({ rootPath: workDir, watcher });
    await fileTree.ready();
    return { fileTree, release: async () => undefined };
  },
}));

const { removeAppFile, forwardTargets, downloadAppFile, revealAppFile, listAppFiles, writeAppFileChunk, readAppFileText, openAppFileIn, watchAppFile, watchAppFolder, FORWARD_MAX_BYTES } = await import('./app-files');
const { events } = await import('@main/lib/events');
const { appFileWatchElsewhereChannel, workingCopyMovedChannel } = await import('@shared/events/appEvents');
const { releaseWorkingCopies } = await import('./working-copy-files');
const { privatePasswordVaultDirectory } = await import('@gugu/core/local/state/protectedPrivateStorage');

/**
 * What every way of reaching a working copy's file answers to, each through the function its bridge verb calls: a door that
 * says `needs: null` leaves the gate to these. Each refusal is asserted by what it says, so a crash on the way cannot pass as one.
 */
const workspace = 'session:11111111-1111-4111-8111-111111111111';
const page = () => ({ pageId: 7, extensionId: 'reader', handed: null }) as never;
const PRIVATE = /protected private storage/;
const DENIED = /Not permitted/;
let outside = '';
let home = '';

beforeEach(async () => {
  releaseWorkingCopies(7);
  f.capabilities.clear();
  f.shown.length = 0;
  f.openIn.mockClear();
  f.machine.mockResolvedValue(null);
  f.root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gates-root-')));
  outside = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gates-out-')));
  home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gates-home-')));
  f.dialogDir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gates-save-')));
  f.dialogFile = path.join(f.dialogDir, 'saved.bin');
  vi.stubEnv('GUGU_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of [f.root, outside, home, f.dialogDir]) await fsp.rm(dir, { recursive: true, force: true });
});

/** The vault inside the working copy, and the relative name of a file in it. */
function vaultInside(): string {
  vi.stubEnv('GUGU_HOME', path.join(f.root, 'home'));
  fs.mkdirSync(privatePasswordVaultDirectory(), { recursive: true });
  const secret = path.join(privatePasswordVaultDirectory(), 'vault.bin');
  fs.writeFileSync(secret, 'canary');
  return path.relative(f.root, secret);
}

describe('remove', () => {
  it('a refusal reaches the page, and no tab hears the file went', async () => {
    f.capabilities.add('files:write');
    const moved: unknown[] = [];
    const off = events.on(workingCopyMovedChannel as never, ((said: unknown) => moved.push(said)) as never);
    vaultInside();
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'keep me');
    await expect(removeAppFile(page(), { ref: { workspace, id: 'a.txt' } })).rejects.toThrow(PRIVATE);
    expect(moved).toEqual([]);
    expect(fs.existsSync(path.join(f.root, 'a.txt'))).toBe(true);
    (off as () => void)();
  });

  it('a removal is done by the time it is answered', async () => {
    f.capabilities.add('files:write');
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'gone');
    await removeAppFile(page(), { ref: { workspace, id: 'a.txt' } });
    expect(fs.existsSync(path.join(f.root, 'a.txt'))).toBe(false);
  });
});

describe('forward', () => {
  it('reads nothing for a page with no file capability', async () => {
    fs.writeFileSync(path.join(f.root, '.env'), 'TOKEN=canary');
    await expect(forwardTargets(page(), { refs: [{ workspace, id: '.env' }] })).rejects.toThrow(DENIED);
  });

  it('the file a page was handed needs nothing', async () => {
    fs.writeFileSync(path.join(f.root, 'mine.txt'), 'mine');
    const handed = { pageId: 7, extensionId: 'reader', handed: { workspace, id: 'mine.txt' } } as never;
    const detail = await forwardTargets(handed, { refs: [{ workspace, id: 'mine.txt' }] }) as { copies: { bytes: Uint8Array }[] };
    expect(Buffer.from(detail.copies[0]!.bytes).toString()).toBe('mine');
  });

  it('another machine asks for all-machines', async () => {
    f.capabilities.add('files:read');
    f.machine.mockResolvedValue({ deviceId: 'dev-b', projectId: 'p' });
    await expect(forwardTargets(page(), { refs: [{ workspace, id: 'a.txt' }] })).rejects.toThrow(/files:read:all-machines/);
    expect(f.remote).not.toHaveBeenCalled();
  });

  it('a file rewritten while it is read comes out one version', async () => {
    f.capabilities.add('files:read');
    const size = 3 * 1024 * 1024;
    const file = path.join(f.root, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(size, 0x41));
    let changed = false;
    const detail = await forwardTargets(page(), { refs: [{ workspace, id: 'big.bin' }], transferId: 't' }, () => {
      if (!changed) { changed = true; fs.writeFileSync(file, Buffer.alloc(size, 0x42)); }
    }) as { copies: { bytes: Uint8Array }[] };
    const bytes = Buffer.from(detail.copies[0]!.bytes);
    expect(bytes.filter((byte) => byte === 0x42).length).toBe(size);
  });

  it('a file that never settles is said, not sent', async () => {
    f.capabilities.add('files:read');
    const size = 3 * 1024 * 1024;
    const file = path.join(f.root, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(size, 0x41));
    let n = 0;
    await expect(forwardTargets(page(), { refs: [{ workspace, id: 'big.bin' }], transferId: 't' }, () => {
      fs.writeFileSync(file, Buffer.alloc(size, 0x43 + (n++ % 2)));
    })).rejects.toMatchObject({ code: 'content-changed' });
  });

  it('over the limit it is refused before it is read', async () => {
    f.capabilities.add('files:read');
    const file = path.join(f.root, 'huge.bin');
    fs.closeSync(fs.openSync(file, 'w'));
    fs.truncateSync(file, FORWARD_MAX_BYTES + 1);
    const heard = vi.fn();
    await expect(forwardTargets(page(), { refs: [{ workspace, id: 'huge.bin' }], transferId: 't' }, heard)).rejects.toMatchObject({ code: 'too-large' });
    expect(heard).not.toHaveBeenCalled();
  });

  it('reads no protected storage', async () => {
    f.capabilities.add('files:read');
    const secret = vaultInside();
    await expect(forwardTargets(page(), { refs: [{ workspace, id: secret }] })).rejects.toThrow(PRIVATE);
  });

  it('the limit is of all the files together', async () => {
    f.capabilities.add('files:read');
    for (const name of ['one.bin', 'two.bin']) {
      fs.closeSync(fs.openSync(path.join(f.root, name), 'w'));
      fs.truncateSync(path.join(f.root, name), FORWARD_MAX_BYTES / 2 + 1);
    }
    await expect(forwardTargets(page(), { refs: ['one.bin', 'two.bin'].map((id) => ({ workspace, id })) })).rejects.toMatchObject({ code: 'too-large' });
  });
});

describe('reading a whole file', () => {
  it('readAppFileText and a download hear the same answer to a file that never settles', async () => {
    f.capabilities.add('files:read');
    const size = 3 * 1024 * 1024;
    const file = path.join(f.root, 'moving.txt');
    fs.writeFileSync(file, Buffer.alloc(size, 0x41));
    let n = 0;
    const moving = () => { fs.writeFileSync(file, Buffer.alloc(size, 0x43 + (n++ % 2))); };
    await expect(readAppFileText(page(), { ref: { workspace, id: 'moving.txt' }, maxBytes: size * 2, transferId: 't' }, moving)).rejects.toMatchObject({ code: 'content-changed' });
    await expect(downloadAppFile(page(), { ref: { workspace, id: 'moving.txt' }, transferId: 't' }, null, moving)).rejects.toMatchObject({ code: 'content-changed' });
    expect(fs.existsSync(f.dialogFile)).toBe(false);
  });
});

describe('downloading a folder', () => {
  it('saves nothing for a page with no file capability', async () => {
    fs.mkdirSync(path.join(f.root, 'sub'));
    fs.writeFileSync(path.join(f.root, 'sub', 'secret.txt'), 'canary');
    await expect(downloadAppFile(page(), { ref: { workspace, id: 'sub' }, folder: true }, null)).rejects.toThrow(DENIED);
    expect(fs.existsSync(path.join(f.dialogDir, 'sub'))).toBe(false);
  });

  it('saves nothing of a working copy holding protected storage', async () => {
    f.capabilities.add('files:read');
    const secret = vaultInside();
    const folder = path.dirname(secret);
    await expect(downloadAppFile(page(), { ref: { workspace, id: folder }, folder: true }, null)).rejects.toThrow(PRIVATE);
    expect(fs.readdirSync(f.dialogDir)).toEqual([]);
  });

  it('a dangling link is left out and said; what is saved stays', async () => {
    f.capabilities.add('files:read');
    fs.mkdirSync(path.join(f.root, 'sub'));
    fs.writeFileSync(path.join(f.root, 'sub', 'ok.txt'), 'ok');
    fs.symlinkSync('/no/such/target', path.join(f.root, 'sub', 'dangling'));
    await expect(downloadAppFile(page(), { ref: { workspace, id: 'sub' }, folder: true }, null)).resolves.toEqual({ skipped: ['sub/dangling'] });
    expect(fs.readFileSync(path.join(f.dialogDir, 'sub', 'ok.txt'), 'utf8')).toBe('ok');
  });

  it('a link out of the working copy, or to a folder above it, is not followed', async () => {
    f.capabilities.add('files:read');
    fs.mkdirSync(path.join(f.root, 'sub'));
    fs.writeFileSync(path.join(f.root, 'sub', 'ok.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'id_rsa'), 'canary');
    fs.symlinkSync(outside, path.join(f.root, 'sub', 'out'));
    fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(f.root, 'sub', 'key'));
    fs.symlinkSync(path.join(f.root, 'sub'), path.join(f.root, 'sub', 'loop'));
    const saved = await downloadAppFile(page(), { ref: { workspace, id: 'sub' }, folder: true }, null) as { skipped: string[] };
    expect(saved.skipped.toSorted()).toEqual(['sub/key', 'sub/loop', 'sub/out']);
    expect(fs.readdirSync(path.join(f.dialogDir, 'sub'))).toEqual(['ok.txt']);
  });
});

describe('writing in parts', () => {
  const chunk = (name: string) => ({ place: { workspace }, path: name, uploadId: 'u', offset: 0, data: Buffer.from('x').toString('base64'), total: 1, final: true, expectedEtag: null });

  it('makes no folder through a link out of the working copy', async () => {
    f.capabilities.add('files:write');
    fs.symlinkSync(outside, path.join(f.root, 'out'));
    await expect(writeAppFileChunk(page(), chunk('out/made/deep/x.txt') as never)).rejects.toThrow(/outside this working copy/);
    expect(fs.existsSync(path.join(outside, 'made'))).toBe(false);
  });

  it('makes no folder above the working copy', async () => {
    f.capabilities.add('files:write');
    await expect(writeAppFileChunk(page(), chunk(`../${path.basename(outside)}/made/x.txt`) as never)).rejects.toThrow(/outside this working copy/);
    expect(fs.existsSync(path.join(outside, 'made'))).toBe(false);
  });

  it('makes the folders a new file inside needs', async () => {
    f.capabilities.add('files:write');
    await writeAppFileChunk(page(), chunk('made/deep/x.txt') as never);
    expect(fs.readFileSync(path.join(f.root, 'made', 'deep', 'x.txt'), 'utf8')).toBe('x');
  });
});

describe('listing', () => {
  it('says which entries are links, and what is behind one out of the working copy is not listed', async () => {
    f.capabilities.add('files:read');
    fs.mkdirSync(privatePasswordVaultDirectory(), { recursive: true });
    fs.writeFileSync(path.join(privatePasswordVaultDirectory(), 'recovery-key.bin'), 'canary');
    fs.writeFileSync(path.join(f.root, 'plain.txt'), 'x');
    fs.symlinkSync(privatePasswordVaultDirectory(), path.join(f.root, 'vaultlink'));
    fs.symlinkSync(outside, path.join(f.root, 'outlink'));
    fs.mkdirSync(path.join(f.root, 'in'));
    fs.symlinkSync(path.join(f.root, 'in'), path.join(f.root, 'inlink'));
    const top = await listAppFiles(page(), { place: { workspace } }) as { id: string; symlink?: true }[];
    expect(top.find((entry) => entry.id === 'plain.txt')?.symlink).toBeUndefined();
    expect(top.find((entry) => entry.id === 'vaultlink')?.symlink).toBe(true);
    await expect(listAppFiles(page(), { place: { workspace }, folder: 'vaultlink' })).rejects.toThrow(/outside this working copy/);
    await expect(listAppFiles(page(), { place: { workspace }, folder: 'outlink' })).rejects.toThrow(/outside this working copy/);
    await expect(listAppFiles(page(), { place: { workspace }, folder: 'inlink' })).resolves.toEqual([]);
  });
});

describe('watching', () => {
  it('another machine asks for all-machines, a file and a folder alike', async () => {
    f.capabilities.add('files:read');
    f.machine.mockResolvedValue({ deviceId: 'dev-b', projectId: 'p' });
    const asked: unknown[] = [];
    const off = events.on(appFileWatchElsewhereChannel as never, ((said: unknown) => asked.push(said)) as never);
    await expect(watchAppFile(page(), { workspace, id: 'x.txt' }, () => undefined)).rejects.toThrow(/files:read:all-machines/);
    await expect(watchAppFolder(page(), { workspace }, undefined, () => undefined)).rejects.toThrow(/files:read:all-machines/);
    expect(asked).toEqual([]);
    (off as () => void)();
  });
});

describe('reveal', () => {
  it('shows a file of the working copy', async () => {
    f.capabilities.add('files:read');
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'x');
    await revealAppFile(page(), { ref: { workspace, id: 'a.txt' } });
    expect(f.shown).toEqual([path.join(f.root, 'a.txt')]);
  });

  it('refuses a path leaving the working copy', async () => {
    f.capabilities.add('files:read');
    await expect(revealAppFile(page(), { ref: { workspace, id: '../../etc/passwd' } })).rejects.toThrow(/No file/);
    expect(f.shown).toEqual([]);
  });

  it('refuses protected storage', async () => {
    f.capabilities.add('files:read');
    const secret = vaultInside();
    await expect(revealAppFile(page(), { ref: { workspace, id: secret } })).rejects.toThrow(PRIVATE);
    expect(f.shown).toEqual([]);
  });

  it('refuses another machine', async () => {
    f.capabilities.add('files:read');
    f.machine.mockResolvedValue({ deviceId: 'dev-b', projectId: 'p' });
    await expect(revealAppFile(page(), { ref: { workspace, id: 'a.txt' } })).rejects.toThrow(/another computer/);
  });
});

describe('reveal and Open in, to a program of this computer', () => {
  const handedPage = (id: string) => ({ pageId: 7, extensionId: 'reader', handed: { workspace, id } }) as never;

  it('a page with no file capability reaches neither', async () => {
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'x');
    await expect(revealAppFile(page(), { ref: { workspace, id: 'a.txt' } })).rejects.toThrow(DENIED);
    await expect(openAppFileIn(page(), { ref: { workspace, id: 'a.txt' }, app: 'vscode' })).rejects.toThrow(DENIED);
    expect(f.shown).toEqual([]);
    expect(f.openIn).not.toHaveBeenCalled();
  });

  it('an absolute path is the one handed to the page, or refused', async () => {
    f.capabilities.add('files:read');
    const file = path.join(outside, 'mine.txt');
    fs.writeFileSync(file, 'x');
    await expect(revealAppFile(page(), { ref: { workspace, id: file } })).rejects.toThrow(/handed|Not permitted|absolute/i);
    await expect(openAppFileIn(page(), { ref: { workspace, id: file }, app: 'vscode' })).rejects.toThrow(/handed|Not permitted|absolute/i);
    expect(f.openIn).not.toHaveBeenCalled();
    await openAppFileIn(handedPage(file), { ref: { workspace, id: file }, app: 'vscode' });
    expect(f.openIn).toHaveBeenCalledWith({ app: 'vscode', path: file });
  });

  it('Open in does not pass through a link out of the working copy, or to protected storage', async () => {
    f.capabilities.add('files:read');
    fs.mkdirSync(privatePasswordVaultDirectory(), { recursive: true });
    fs.writeFileSync(path.join(privatePasswordVaultDirectory(), 'key.bin'), 'canary');
    fs.symlinkSync(path.join(privatePasswordVaultDirectory(), 'key.bin'), path.join(f.root, 'keylink'));
    await expect(openAppFileIn(page(), { ref: { workspace, id: 'keylink' }, app: 'vscode' })).rejects.toThrow(/No file/);
    expect(f.openIn).not.toHaveBeenCalled();
  });

  it('Open in takes a link inside to what it points at, and says which program it needs', async () => {
    f.capabilities.add('files:read');
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'x');
    fs.symlinkSync(path.join(f.root, 'a.txt'), path.join(f.root, 'alias'));
    await openAppFileIn(page(), { ref: { workspace, id: 'alias' }, app: 'vscode' });
    expect(f.openIn).toHaveBeenCalledWith({ app: 'vscode', path: path.join(f.root, 'a.txt') });
    await expect(openAppFileIn(page(), { ref: { workspace, id: 'a.txt' }, app: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('saving a file', () => {
  it('a file outside the working copy, handed to the page, saves with no capability', async () => {
    const file = path.join(outside, 'mine.txt');
    fs.writeFileSync(file, 'outside');
    const handed = { pageId: 7, extensionId: 'reader', handed: { workspace, id: file } } as never;
    let saved = '';
    await downloadAppFile(handed, { ref: { workspace, id: file } }, null, undefined, (at) => { saved = at; });
    expect(saved).toBe(f.dialogFile);
    expect(fs.readFileSync(f.dialogFile, 'utf8')).toBe('outside');
  });
});

describe('watching through a link', () => {
  it('a folder link out of the working copy is not watched', async () => {
    f.capabilities.add('files:read');
    fs.symlinkSync(outside, path.join(f.root, 'outlink'));
    await expect(watchAppFolder(page(), { workspace }, 'outlink', () => undefined)).rejects.toThrow(/outside this working copy/);
  });
});
