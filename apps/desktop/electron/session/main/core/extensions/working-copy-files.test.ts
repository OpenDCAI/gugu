import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@gugu/session-shared';

/**
 * A working copy nothing has opened since this computer started: `files.list` and `files.onChanged` work from its folder
 * alone. The workspace registry is not mocked because nothing here may reach it: mounting runs the project's scripts.
 */
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'working-copy-')));
fs.writeFileSync(path.join(root, 'README.md'), 'hello');
fs.mkdirSync(path.join(root, 'src'));

const released = { tree: 0, feed: 0, unsubscribed: 0, directory: 0 };
let opensFail = false;
let watchFails = false;
let readyFails = false;
const watchedDirectories: string[] = [];
let feed: (update: unknown) => void = () => undefined;

vi.mock('./app-files', () => ({ localRootOf: async () => ({ workspaceRoot: root, projectId: 'p', workspaceId: 'ws' }), hearElsewhere: vi.fn() }));
vi.mock('./app-programs-elsewhere', () => ({ sessionMachine: async () => null }));
vi.mock('./local-files', () => ({
  workingCopyEntry: (_place: unknown, rel: string) => ({ id: rel, name: rel, type: 'file' }),
  workingCopyFolder: (_place: unknown, rel: string) => ({ id: rel, name: rel, type: 'folder', suffix: '' }),
}));
vi.mock('@main/core/workspaces/workspace-runtime', () => ({
  acquireWorkspaceRuntime: async (_runtime: unknown, workDir: string, gitless: boolean) => {
    if (opensFail) throw new Error(`Failed to open file tree: ${workDir}`);
    expect(gitless).toBe(true);
    const entries = [
      { id: 1, path: path.join(workDir, 'src'), name: 'src', parentId: null, childrenLoaded: false, type: 'directory' },
      { id: 2, path: path.join(workDir, 'README.md'), name: 'README.md', parentId: null, childrenLoaded: false, type: 'file' },
    ];
    return {
      fileTree: {
        rootPath: workDir,
        ready: async () => ok<void>(),
        subscribe: (cb: (update: unknown) => void) => {
          cb({ kind: 'snapshot', entries: entries.map((node) => [node.id, node] as const) });
          return () => undefined;
        },
        registerDir: async () => ok({}),
        unregisterDir: async () => ok({}),
      },
      release: async () => { released.tree += 1; },
    };
  },
}));
vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: async () => ({
      value: {
        files: {
          watchChanges: (_root: string, cb: (update: unknown) => void) => {
            if (watchFails) return err({ type: 'unavailable' });
            feed = cb;
            return ok({
              ready: async () => (readyFails ? err({ type: 'unavailable' }) : ok<void>()),
              unsubscribe: () => { released.unsubscribed += 1; },
            });
          },
          watchDirectory: (dir: string) => {
            watchedDirectories.push(dir);
            return ok(() => { released.directory += 1; });
          },
        },
      },
      release: async () => { released.feed += 1; },
    }),
  },
}));

const { listWorkingCopy, releaseWorkingCopies, watchWorkingCopy, writeWorkingCopyChunk } = await import('./working-copy-files');
const place = { workspace: { session: 'never-opened' } } as never;

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  released.tree = 0; released.feed = 0; released.unsubscribed = 0; released.directory = 0;
  opensFail = false; watchFails = false; readyFails = false; feed = () => undefined;
  watchedDirectories.length = 0;
});

describe('a working copy nothing has opened', () => {
  it('files.list answers from its folder, and a one-off call lets the tree go', async () => {
    const entries = await listWorkingCopy(place, undefined, null);
    expect(entries.map((entry) => entry.parentId)).toEqual([null, null]);
    expect(entries.map((entry) => entry.type).sort()).toEqual(['file', 'folder']);
    expect(released.tree).toBe(1);
  });

  it("a page keeps its tree until the page is let go of", async () => {
    await listWorkingCopy(place, undefined, 7);
    await listWorkingCopy(place, undefined, 7);
    expect(released.tree).toBe(0);
    releaseWorkingCopies(7);
    await vi.waitFor(() => expect(released.tree).toBe(1));
  });

  it('a folder that cannot be opened is said, without its path', async () => {
    opensFail = true;
    await expect(listWorkingCopy(place, undefined, null)).rejects.toMatchObject({ code: 'not-found', message: 'This folder cannot be read on its computer' });
  });

  it('files.onChanged hears the folder from the start, not silently after a mount', async () => {
    const heard: unknown[] = [];
    const stop = await watchWorkingCopy(place, 'src', (change) => heard.push(change));
    feed({ kind: 'changes', changes: [
      { kind: 'modify', path: path.join(root, 'src/a.ts') },
      { kind: 'modify', path: path.join(root, 'README.md') },
    ] });
    feed({ kind: 'resync' });
    expect(heard).toEqual([{ kind: 'changes', changes: [{ kind: 'modify', path: 'src/a.ts' }] }, { kind: 'resync' }]);
    stop();
    expect(watchedDirectories).toEqual([path.join(root, 'src')]);
    expect(released).toMatchObject({ unsubscribed: 1, directory: 1, feed: 1 });
  });

  it('a watch that cannot start is an error, never a quiet success', async () => {
    watchFails = true;
    await expect(watchWorkingCopy(place, undefined, () => undefined)).rejects.toMatchObject({ code: 'not-found' });
    expect(released.feed).toBe(1);
  });

  it('a watch whose native start fails later is an error too, and lets everything go', async () => {
    readyFails = true;
    await expect(watchWorkingCopy(place, undefined, () => undefined)).rejects.toMatchObject({ code: 'not-found' });
    expect(released).toMatchObject({ unsubscribed: 1, directory: 1, feed: 1 });
  });
});

describe('a file going into a working copy, part by part', () => {
  const part = (over: Record<string, unknown>) => ({ path: 'in/deep/new.bin', uploadId: 'u1', offset: 0, data: Buffer.from('abc').toString('base64'), total: 6, final: false, expectedEtag: null, ...over });
  const b64 = (text: string) => Buffer.from(text).toString('base64');

  it('makes its folders, holds the bytes beside it until the last part, then answers with the entry', async () => {
    expect(await writeWorkingCopyChunk(place, part({}))).toEqual({ received: 3 });
    expect(fs.existsSync(path.join(root, 'in/deep/new.bin'))).toBe(false);
    const done = await writeWorkingCopyChunk(place, part({ offset: 3, data: b64('def'), final: true }));
    expect(done.entry?.id).toBe('in/deep/new.bin');
    expect(fs.readFileSync(path.join(root, 'in/deep/new.bin'), 'utf8')).toBe('abcdef');
    expect(fs.readdirSync(path.join(root, 'in/deep'))).toEqual(['new.bin']);
  });

  it('a file of more than the old 100 MiB is taken: only the announced total is over it, nothing is held', async () => {
    const total = 101 * 1024 * 1024;
    expect(await writeWorkingCopyChunk(place, part({ path: 'large.bin', uploadId: 'u2', total }))).toEqual({ received: 3 });
  });

  it('a name already there is said at the first part, and written only when replacing was asked', async () => {
    fs.writeFileSync(path.join(root, 'taken.txt'), 'old');
    await expect(writeWorkingCopyChunk(place, part({ path: 'taken.txt', uploadId: 'u3', total: 3, final: true })))
      .rejects.toMatchObject({ code: 'name-taken' });
    expect(fs.readFileSync(path.join(root, 'taken.txt'), 'utf8')).toBe('old');
    await writeWorkingCopyChunk(place, part({ path: 'taken.txt', uploadId: 'u4', total: 3, final: true, expectedEtag: '*' }));
    expect(fs.readFileSync(path.join(root, 'taken.txt'), 'utf8')).toBe('abc');
  });

  it('a path out of the working copy makes no folder', async () => {
    const sibling = `up-${path.basename(root)}`;
    await expect(writeWorkingCopyChunk(place, part({ path: `../${sibling}/x`, uploadId: 'u5' }))).rejects.toMatchObject({ code: 'invalid' });
    expect(fs.existsSync(path.join(root, '..', sibling))).toBe(false);
  });
});
