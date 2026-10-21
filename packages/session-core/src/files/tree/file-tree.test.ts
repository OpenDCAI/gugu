import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Result } from '@gugu/session-shared';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitPending } from '../../../../../tests/support/awaitFact';
import type {
  IWatchService,
  WatchEvent,
  WatchHandle,
  WatchOptions,
} from '../../services/fs-watch/api';
import { FilesRuntime } from '../files-runtime';
import { FileTree } from './file-tree';
import type { FileNode } from './models/tree';

class ManualWatchService implements IWatchService {
  async nudge(): Promise<boolean> {
    return false;
  }
  private consumers: Array<{
    onEvents: (events: WatchEvent[]) => void;
    onResync?: () => void;
  }> = [];
  private readyCalls = 0;
  private releaseCalls = 0;
  private releaseWaiters: Array<{ count: number; resolve: () => void }> = [];
  readonly subscribed: Array<{ root: string; recursive: boolean }> = [];
  readonly live = new Set<string>();

  get watchCount(): number {
    return this.readyCalls;
  }

  get releaseCount(): number {
    return this.releaseCalls;
  }

  watch(
    root: string,
    onEvents: (events: WatchEvent[]) => void,
    options: WatchOptions = {}
  ): WatchHandle {
    const consumer = { onEvents, onResync: options.onResync };
    this.consumers.push(consumer);
    this.readyCalls += 1;
    this.subscribed.push({ root, recursive: options.recursive ?? true });
    this.live.add(root);
    return {
      ready: async () => {},
      release: async () => {
        this.releaseCalls += 1;
        this.live.delete(root);
        this.consumers = this.consumers.filter((candidate) => candidate !== consumer);
        const due = this.releaseWaiters.filter((waiter) => waiter.count <= this.releaseCalls);
        this.releaseWaiters = this.releaseWaiters.filter((waiter) => !due.includes(waiter));
        for (const waiter of due) waiter.resolve();
      },
    };
  }

  /** 第 `count` 次 release 发生时 resolve(已经发生过就立刻)。 */
  released(count: number): Promise<void> {
    if (this.releaseCalls >= count) return Promise.resolve();
    return new Promise((resolve) => this.releaseWaiters.push({ count, resolve }));
  }

  emit(events: WatchEvent[]): void {
    for (const consumer of this.consumers) consumer.onEvents(events);
  }

  resync(): void {
    for (const consumer of this.consumers) consumer.onResync?.();
  }

  async dispose(): Promise<void> {}
}

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'emdash-file-tree-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileTree', () => {
  it('loads only the root scope at startup and expands directories lazily', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'nested', 'a.ts'), 'a', 'utf8');
    await writeFile(path.join(root, 'README.md'), 'readme', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    expect(paths(await nodes(tree))).toEqual(['src', 'README.md']);
    const src = nodeByPath(await nodes(tree), 'src');
    expect(src.childrenLoaded).toBe(false);

    await expect(tree.registerDir(src.id)).resolves.toMatchObject({
      success: true,
      data: { tree: expect.any(Number) },
    });

    const expanded = await nodes(tree);
    expect(paths(expanded)).toEqual(['src', 'README.md', 'src/nested']);
    expect(nodeByPath(expanded, 'src').childrenLoaded).toBe(true);
    await tree.dispose();
  });

  it('loads a scope on register (idempotently) and unloads it on unregister', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'nested', 'a.ts'), 'a', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());
    const src = nodeByPath(await nodes(tree), 'src');

    // Register is idempotent: a second register while loaded is a no-op.
    unwrap(await tree.registerDir(src.id));
    unwrap(await tree.registerDir(src.id));
    expect(paths(await nodes(tree))).toContain('src/nested');

    // Unregister unloads the scope immediately. The projector is the sole ref-count
    // authority, so core does not double-count registrations.
    unwrap(await tree.unregisterDir(src.id));
    expect(paths(await nodes(tree))).not.toContain('src/nested');
    await tree.dispose();
  });

  it('keeps the root scope pinned across register/unregister of root', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'README.md'), 'readme', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    unwrap(await tree.registerDir(null));
    unwrap(await tree.unregisterDir(null));
    // Root must remain loaded even after balanced register/unregister.
    expect(paths(await nodes(tree))).toEqual(['README.md']);
    await tree.dispose();
  });

  it('prunes orphaned descendant scopes and node records when a parent is unregistered', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b', 'leaf.ts'), 'x', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    const a = nodeByPath(await nodes(tree), 'a');
    unwrap(await tree.registerDir(a.id));
    const b = nodeByPath(await nodes(tree), 'a/b');
    unwrap(await tree.registerDir(b.id));
    expect(paths(await nodes(tree))).toContain('a/b/leaf.ts');

    // Collapsing `a` drops its direct children and the now-orphaned `a/b` scope plus its
    // descendants.
    unwrap(await tree.unregisterDir(a.id));
    expect(paths(await nodes(tree))).toEqual(['a']);

    // Re-expanding reloads fresh children with no stale state.
    const aAgain = nodeByPath(await nodes(tree), 'a');
    unwrap(await tree.registerDir(aAgain.id));
    expect(paths(await nodes(tree))).toContain('a/b');
    await tree.dispose();
  });

  it('annotates directory children with preview metadata for a single-child chain', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'a', 'b', 'c'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b', 'c', 'leaf.ts'), 'x', 'utf8');
    await mkdir(path.join(root, 'multi'), { recursive: true });
    await writeFile(path.join(root, 'multi', 'one.ts'), '1', 'utf8');
    await writeFile(path.join(root, 'multi', 'two.ts'), '2', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    // `a` heads a single-child chain `a -> a/b -> a/b/c` (which then holds a file), computed from
    // the root listing without loading any of those scopes.
    const a = nodeByPath(await nodes(tree), 'a');
    expect(a.directoryPreview?.childCount).toBe(1);
    expect(a.directoryPreview?.singleChildDirectoryChain.map((segment) => segment.name)).toEqual([
      'b',
      'c',
    ]);
    expect(a.directoryPreview?.singleChildDirectoryChain.map((segment) => segment.path)).toEqual([
      path.join(root, 'a', 'b'),
      path.join(root, 'a', 'b', 'c'),
    ]);

    // `multi` has two children, so it does not compact.
    const multi = nodeByPath(await nodes(tree), 'multi');
    expect(multi.directoryPreview?.childCount).toBe(2);
    expect(multi.directoryPreview?.singleChildDirectoryChain).toEqual([]);

    // Expanding the chain head loads only its direct child, which carries the rest of the chain.
    unwrap(await tree.registerDir(a.id));
    const b = nodeByPath(await nodes(tree), 'a/b');
    expect(b.directoryPreview?.childCount).toBe(1);
    expect(b.directoryPreview?.singleChildDirectoryChain.map((segment) => segment.name)).toEqual([
      'c',
    ]);
    await tree.dispose();
  });

  it('drops a head compaction chain when a chain member gains a second child (watch)', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    await writeFile(path.join(root, 'a', 'b', 'leaf.ts'), 'x', 'utf8');
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());

    expect(
      nodeByPath(await nodes(tree), 'a').directoryPreview?.singleChildDirectoryChain.map(
        (s) => s.name
      )
    ).toEqual(['b']);

    // Add a second child to the (unloaded) head `a`, breaking its single-child chain. The change
    // only surfaces through compaction re-annotation, not normal child add/remove.
    const before = previewOf(await nodes(tree), 'a');
    await writeFile(path.join(root, 'a', 'sibling.ts'), 'y', 'utf8');
    watcher.emit([{ kind: 'create', path: path.join(root, 'a', 'sibling.ts') }]);

    // 等 a 的预览变掉(那一次重算推出来的更新),再判它变成了什么 —— 算错了是红,不是挂住。
    await untilTree(tree, 'a is re-annotated after the create', (all) => previewOf(all, 'a') !== before);
    const a = nodeByPath(await nodes(tree), 'a');
    expect(a.directoryPreview?.childCount).toBe(2);
    expect(a.directoryPreview?.singleChildDirectoryChain).toEqual([]);
    await tree.dispose();
  });

  it('forms a head compaction chain when a directory drops to a single child (watch)', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'a', 'b1'), { recursive: true });
    await mkdir(path.join(root, 'a', 'b2'), { recursive: true });
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());

    expect(nodeByPath(await nodes(tree), 'a').directoryPreview?.childCount).toBe(2);
    expect(nodeByPath(await nodes(tree), 'a').directoryPreview?.singleChildDirectoryChain).toEqual(
      []
    );

    const before = previewOf(await nodes(tree), 'a');
    await rm(path.join(root, 'a', 'b2'), { recursive: true, force: true });
    watcher.emit([{ kind: 'delete', path: path.join(root, 'a', 'b2') }]);

    await untilTree(tree, 'a is re-annotated after the delete', (all) => previewOf(all, 'a') !== before);
    const a = nodeByPath(await nodes(tree), 'a');
    expect(a.directoryPreview?.childCount).toBe(1);
    expect(a.directoryPreview?.singleChildDirectoryChain.map((s) => s.name)).toEqual(['b1']);
    await tree.dispose();
  });

  it('includes noisy directories in the file tree by default', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    await writeFile(path.join(root, 'src', 'index.ts'), 'x', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    expect(paths(await nodes(tree))).toEqual(['.git', 'node_modules', 'src']);
    await tree.dispose();
  });

  it('includes symlinks in snapshots and watch-created entries', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'target.txt'), 'x', 'utf8');
    const symlinkSupported = await trySymlink('target.txt', path.join(root, 'link.txt'));
    if (!symlinkSupported) return;

    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());

    const initial = await nodes(tree);
    expect(paths(initial)).toEqual(['link.txt', 'target.txt']);
    expect(nodeByPath(initial, 'link.txt')).toMatchObject({
      type: 'symlink',
      symlink: { targetType: 'file', broken: false },
    });

    const patched = tree as unknown as {
      applyWatchEvents(events: WatchEvent[]): Promise<void>;
    };
    const originalApplyWatchEvents = patched.applyWatchEvents;
    let resolveApplied: () => void = () => {};
    const applied = new Promise<void>((resolve) => {
      resolveApplied = resolve;
    });
    patched.applyWatchEvents = async (events) => {
      try {
        await originalApplyWatchEvents.call(tree, events);
      } finally {
        resolveApplied();
      }
    };

    await symlink('target.txt', path.join(root, 'watch-link.txt'), 'file');
    watcher.emit([{ kind: 'create', path: path.join(root, 'watch-link.txt') }]);
    await applied;

    expect(paths(await nodes(tree))).toEqual(['link.txt', 'target.txt', 'watch-link.txt']);
    patched.applyWatchEvents = originalApplyWatchEvents;
    tree.dispose();
  });

  it('expands symlink directories under their logical path without compact previews', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'real', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'real', 'nested', 'a.ts'), 'x', 'utf8');
    const symlinkSupported = await trySymlink('real', path.join(root, 'linked'), 'dir');
    if (!symlinkSupported) return;

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    const initial = await nodes(tree);
    const linked = nodeByPath(initial, 'linked');
    const real = nodeByPath(initial, 'real');
    expect(linked).toMatchObject({
      type: 'symlink',
      symlink: { targetType: 'directory', broken: false },
    });
    expect(linked.directoryPreview).toBeUndefined();
    expect(real.directoryPreview?.singleChildDirectoryChain.map((segment) => segment.name)).toEqual(
      ['nested']
    );

    unwrap(await tree.registerDir(linked.id));
    unwrap(await tree.registerDir(real.id));

    const expanded = await nodes(tree);
    expect(paths(expanded)).toEqual(['linked', 'real', 'linked/nested', 'real/nested']);
    expect(nodeByPath(expanded, 'linked/nested').id).not.toBe(
      nodeByPath(expanded, 'real/nested').id
    );
    await tree.dispose();
  });

  it('reveals a nested path by loading each parent scope', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a', 'file.ts'), 'x', 'utf8');

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    await expect(tree.revealPath(path.join(root, 'src/a/file.ts'))).resolves.toMatchObject({
      success: true,
      data: { tree: expect.any(Number) },
    });

    expect(paths(await nodes(tree))).toEqual(['src', 'src/a', 'src/a/file.ts']);
    await tree.dispose();
  });

  it('returns not-found when revealPath cannot find a loaded path component', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src'), { recursive: true });

    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    unwrap(await tree.ready());

    await expect(tree.revealPath(path.join(root, 'src/missing/file.ts'))).resolves.toMatchObject({
      success: false,
      error: { type: 'not-found', path: path.join(root, 'src/missing') },
    });
    await tree.dispose();
  });

  it('does not cache a rejected ready promise after unexpected load failures', async () => {
    const root = await makeRoot();
    const tree = new FileTree({ rootPath: root, watcher: new ManualWatchService() });
    const patched = tree as unknown as {
      loadDirectoryScope(scope: null): Promise<Result<unknown, unknown>>;
    };
    const originalLoadDirectoryScope = patched.loadDirectoryScope;
    let calls = 0;
    patched.loadDirectoryScope = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { success: true, data: {} };
    };

    try {
      await expect(tree.ready()).rejects.toThrow('boom');
      await expect(tree.ready()).resolves.toEqual({ success: true, data: undefined });
      expect(calls).toBe(2);
    } finally {
      patched.loadDirectoryScope = originalLoadDirectoryScope;
      await tree.dispose();
    }
  });

  it('reuses a node id for a delete/create rename batch with matching inode', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());
    const before = nodeByPath(await nodes(tree), 'a.txt');

    await rename(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    watcher.emit([
      { kind: 'delete', path: path.join(root, 'a.txt') },
      { kind: 'create', path: path.join(root, 'b.txt') },
    ]);
    await waitForNode(tree, 'b.txt');

    const after = await nodes(tree);
    expect(nodeByPath(after, 'b.txt').id).toBe(before.id);
    expect(after.some((node) => node.path === 'a.txt')).toBe(false);
    await tree.dispose();
  });

  it('reuses directory and descendant ids when a loaded directory is renamed', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'nested', 'a.ts'), 'x', 'utf8');
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());
    unwrap(await tree.revealPath(path.join(root, 'src/nested/a.ts')));
    const before = await nodes(tree);
    const src = nodeByPath(before, 'src');
    const nested = nodeByPath(before, 'src/nested');
    const file = nodeByPath(before, 'src/nested/a.ts');

    await rename(path.join(root, 'src'), path.join(root, 'lib'));
    watcher.emit([
      { kind: 'delete', path: path.join(root, 'src') },
      { kind: 'create', path: path.join(root, 'lib') },
    ]);
    await waitForNode(tree, 'lib/nested/a.ts');

    const after = await nodes(tree);
    expect(new Set(paths(after))).toEqual(new Set(['lib', 'lib/nested', 'lib/nested/a.ts']));
    expect(nodeByPath(after, 'lib').id).toBe(src.id);
    expect(nodeByPath(after, 'lib/nested').id).toBe(nested.id);
    expect(nodeByPath(after, 'lib/nested/a.ts').id).toBe(file.id);
    await tree.dispose();
  });

  it('cascades loaded descendants when a directory disappears', async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'src', 'nested', 'a.ts'), 'x', 'utf8');
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());
    await tree.revealPath(path.join(root, 'src/nested/a.ts'));
    expect(paths(await nodes(tree))).toEqual(['src', 'src/nested', 'src/nested/a.ts']);

    await rm(path.join(root, 'src'), { recursive: true });
    watcher.emit([{ kind: 'delete', path: path.join(root, 'src') }]);
    // 等 src 这一行没了(删除那一批已应用),再判它的子孙是不是一起没了。
    await untilTree(tree, 'src is removed', (all) => !hasNode(all, 'src'));

    expect(paths(await nodes(tree))).toEqual([]);
    await tree.dispose();
  });

  it('serializes refreshes and watch event mutations', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());

    const patched = tree as unknown as {
      refreshRegisteredScopes(): Promise<Result<unknown, unknown>>;
      applyWatchEvents(events: WatchEvent[]): Promise<void>;
    };
    const originalRefreshLoadedScopes = patched.refreshRegisteredScopes;
    const originalApplyWatchEvents = patched.applyWatchEvents;

    let activeMutations = 0;
    let maxActiveMutations = 0;
    const enterMutation = () => {
      activeMutations += 1;
      maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
    };
    const exitMutation = () => {
      activeMutations -= 1;
    };

    let releaseRefresh: () => void = () => {};
    const refreshEntered = new Promise<void>((resolve) => {
      patched.refreshRegisteredScopes = async () => {
        enterMutation();
        resolve();
        await new Promise<void>((release) => {
          releaseRefresh = release;
        });
        try {
          return await originalRefreshLoadedScopes.call(tree);
        } finally {
          exitMutation();
        }
      };
    });

    let resolveWatchApplied: () => void = () => {};
    const watchApplied = new Promise<void>((resolve) => {
      resolveWatchApplied = resolve;
    });
    patched.applyWatchEvents = async (events) => {
      enterMutation();
      try {
        await originalApplyWatchEvents.call(tree, events);
      } finally {
        exitMutation();
        resolveWatchApplied();
      }
    };

    const refresh = tree.refresh();
    await refreshEntered;

    await writeFile(path.join(root, 'created.txt'), 'x', 'utf8');
    watcher.emit([{ kind: 'create', path: path.join(root, 'created.txt') }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxActiveMutations).toBe(1);

    releaseRefresh();
    await refresh;
    await watchApplied;

    expect(maxActiveMutations).toBe(1);
    patched.refreshRegisteredScopes = originalRefreshLoadedScopes;
    patched.applyWatchEvents = originalApplyWatchEvents;
    tree.dispose();
  });

  it('coalesces a resync burst to one active and one trailing refresh', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'a.txt'), 'x', 'utf8');
    const watcher = new ManualWatchService();
    const tree = new FileTree({ rootPath: root, watcher });
    unwrap(await tree.ready());

    const patched = tree as unknown as {
      refreshRegisteredScopes(): Promise<Result<unknown, unknown>>;
    };
    const originalRefreshRegisteredScopes = patched.refreshRegisteredScopes;
    let refreshCount = 0;
    let releaseFirstRefresh: () => void = () => {};
    const firstRefreshEntered = new Promise<void>((resolve) => {
      patched.refreshRegisteredScopes = async () => {
        refreshCount += 1;
        if (refreshCount === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseFirstRefresh = release;
          });
        }
        return originalRefreshRegisteredScopes.call(tree);
      };
    });

    watcher.resync();
    await firstRefreshEntered;
    for (let index = 0; index < 10; index += 1) watcher.resync();

    expect(refreshCount).toBe(1);
    releaseFirstRefresh();
    await tree.refresh();

    expect(refreshCount).toBe(3);
    patched.refreshRegisteredScopes = originalRefreshRegisteredScopes;
    await tree.dispose();
  });

  it('runtime leases share one tree per resolved root', async () => {
    const root = await makeRoot();
    const watcher = new ManualWatchService();
    const runtime = new FilesRuntime({ watcher });

    const first = await runtime.openTree(root);
    const second = await runtime.openTree(root);
    const firstLease = unwrap(first);
    const secondLease = unwrap(second);

    expect(firstLease.value).toBe(secondLease.value);
    expect(watcher.watchCount).toBe(1);

    await firstLease.release();
    await secondLease.release();
    await runtime.dispose();
  });

  it('returns a typed error when opening a missing root', async () => {
    const root = path.join(await makeRoot(), 'missing');
    const runtime = new FilesRuntime({ watcher: new ManualWatchService() });

    await expect(runtime.openTree(root)).resolves.toMatchObject({
      success: false,
      error: { type: 'not-found', path: root },
    });
    await runtime.dispose();
  });

  it('releases the runtime lease when ready rejects unexpectedly', async () => {
    const root = await makeRoot();
    const watcher = new ManualWatchService();
    const runtime = new FilesRuntime({ watcher });
    const originalReady = FileTree.prototype.ready;
    FileTree.prototype.ready = async () => {
      throw new Error('boom');
    };

    try {
      await expect(runtime.openTree(root)).rejects.toThrow('boom');
      await awaitPending('runtime releases the tree lease', watcher.released(1));
      expect(watcher.releaseCount).toBe(1);
    } finally {
      FileTree.prototype.ready = originalReady;
      await runtime.dispose();
    }
  });
});

async function nodes(tree: FileTree): Promise<FileNode[]> {
  return unwrap(await tree.getSnapshot()).entries.map(([, node]) => node);
}

function paths(nodes: FileNode[]): string[] {
  const root = commonRoot(nodes.map((node) => node.path));
  return nodes.map((node) => path.relative(root, node.path).replace(/\\/g, '/'));
}

function nodeByPath(nodes: FileNode[], expectedPath: string): FileNode {
  const root = commonRoot(nodes.map((node) => node.path));
  const node = nodes.find(
    (candidate) =>
      candidate.path === expectedPath ||
      path.relative(root, candidate.path).replace(/\\/g, '/') === expectedPath
  );
  if (!node) throw new Error(`Missing node ${expectedPath}`);
  return node;
}

/**
 * 等树自己推出来的更新:先判一次,之后每来一条 FileTree 更新就重判一次,成立为止。
 * 替身 watcher 的事件是同步喂进去的,应用它要走真 fs(stat / readdir)—— 要多久由机器定,❌ 设期限。
 */
async function untilTree(
  tree: FileTree,
  step: string,
  holds: (nodes: FileNode[]) => boolean
): Promise<void> {
  let notify = () => {};
  const unsubscribe = tree.subscribe(() => notify());
  try {
    await awaitPending(
      step,
      (async () => {
        for (;;) {
          const changed = new Promise<void>((resolve) => (notify = resolve));
          if (holds(await nodes(tree))) return;
          await changed;
        }
      })()
    );
  } finally {
    unsubscribe();
  }
}

async function waitForNode(tree: FileTree, expectedPath: string): Promise<void> {
  await untilTree(tree, `node ${expectedPath} appears`, (all) => hasNode(all, expectedPath));
}

function previewOf(all: FileNode[], expectedPath: string): string {
  return JSON.stringify(nodeByPath(all, expectedPath).directoryPreview);
}

function hasNode(all: FileNode[], expectedPath: string): boolean {
  try {
    nodeByPath(all, expectedPath);
    return true;
  } catch {
    return false;
  }
}

function commonRoot(paths: string[]): string {
  if (paths.length === 0) return '';
  let root = path.dirname(paths[0]);
  for (const current of paths.slice(1)) {
    while (root && !isSameOrChild(root, current)) {
      const next = path.dirname(root);
      if (next === root) break;
      root = next;
    }
  }
  return root;
}

function isSameOrChild(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function trySymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir' = 'file'
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw error;
  }
}

function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.success) throw new Error(`Expected ok result: ${JSON.stringify(result.error)}`);
  return result.data;
}
