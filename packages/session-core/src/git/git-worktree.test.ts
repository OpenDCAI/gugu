import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { awaitPending } from '../../../../tests/support/awaitFact';
import type { IWatchService, WatchEvent, WatchOptions } from '../services/fs-watch/api';
import type { WatchSink } from '../services/fs-watch/impl/backend';
import { nativeWatchBackend } from '../services/fs-watch/impl/native-backend';
import { buildIgnoreFilter } from '../services/fs-watch/impl/paths';
import { createWatchService } from '../services/fs-watch/impl/watch-service';
import { GitRuntime, type GitRepoUpdate, type GitWorktreeUpdate } from './index';

const execFileAsync = promisify(execFile);

/**
 * 录下订阅推来的每一条更新;`until` 等到已收到或之后推来的第一条满足条件的更新。
 * 等的是 runtime 自己推出来的那条更新,不设期限(文件事件 + git status 在忙机器上要多久由机器定)。
 */
function recordUpdates<T>(subscribe: (listener: (update: T) => void) => unknown) {
  const updates: T[] = [];
  const waiters = new Set<{ matches: (update: T) => boolean; resolve: () => void }>();
  subscribe((update) => {
    updates.push(update);
    for (const waiter of waiters) {
      if (!waiter.matches(update)) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  });
  const until = (step: string, matches: (update: T) => boolean): Promise<void> =>
    updates.some(matches)
      ? Promise.resolve()
      : awaitPending(step, new Promise<void>((resolve) => waiters.add({ matches, resolve })));
  return { updates, until };
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'emdash-shared-worktree-'));
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
  await writeFile(path.join(repo, 'tracked.txt'), 'before\n', 'utf8');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
  return await realpath(repo);
}

async function makeRepoWithRemote(): Promise<{ repo: string; remote: string }> {
  const remote = await mkdtemp(path.join(tmpdir(), 'emdash-shared-worktree-remote-'));
  await execFileAsync('git', ['init', '--bare'], { cwd: remote });
  const repo = await makeRepo();
  await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  await execFileAsync('git', ['push', '-u', 'origin', 'main'], { cwd: repo });
  return { repo, remote };
}

function expectSuccess<T>(
  result: { success: true; data: T } | { success: false; error: unknown }
): T {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(String(result.error));
  return result.data;
}

function repoFile(repo: string, filePath: string): string {
  return path.join(repo, filePath);
}

function createNativeWatchService() {
  return createWatchService({ backend: nativeWatchBackend() });
}

/** 一个目录下每个文件此刻的样子:改过 = 大小或 mtime 变了。哪些该报给谁,由各 watch 自己的 key 决定(见下)。 */
async function diskState(root: string): Promise<Map<string, string>> {
  const state = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(at);
      } else {
        const info = await stat(at).catch(() => null);
        if (info) state.set(at, `${info.size}:${info.mtimeMs}`);
      }
    }
  };
  await walk(root);
  return state;
}

/**
 * 这几格测的是 runtime 对变更流的反应(该重算 status 时重算、推出来);OS 送不送、多晚送不归它们管。
 * mac1 满载时 fseventsd 晚几分钟、或者干脆不送(#7371 三层 trace 实测):10-17 #7380 / #7381 / #7390 的
 * Unit tests (1/2) 都卡在这个文件「external commit / merge continuation」那两格的等待上,最长等了 765 s,
 * 直到 job 超时被取消 —— 等的是一个可能永远不来的事件,哪个测试都没法让它确定。
 *
 * ⇒ 真的 watch-service(攒批、ignore、分派照旧)+ 真的 GitRuntime(分类、重算、推送照旧),只有 backend 换成测试的:
 * 每做一次磁盘改动(写文件、跑一条 git),按改动前后读到的磁盘差交一批事件 —— 新建或改过 = `create`、没了 =
 * `delete`,与 darwin transport 对 fseventsd 文件事件的报法同形(fsevents-transport.ts)。等待照旧等事实、
 * 不设墙钟(#4357):事件确定送到了,还等不到推送就是 runtime 的错,当场挂住的位置就是它。
 */
function createReplayWatchService() {
  // LiveModel 每 5 分钟兜底重算一次(git-repository.ts REVALIDATE_INTERVAL_MS):事件那条路断了,它会在几分钟后
  // 把等待救成一个迟到的绿。这几格测的正是事件那条路,所以冻住它 —— 一分钟以上的定时器一律不响;短的
  // (watch-service 攒批、LiveModel 去抖、下面的投递)照常走真的。awaitFact 用的是模块加载时拿到的 setTimeout,不受影响。
  const realSetTimeout = globalThis.setTimeout;
  const frozen = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) =>
    (ms ?? 0) >= 60_000 ? realSetTimeout(() => {}, 2_147_483_647).unref() : realSetTimeout(handler, ms, ...args)) as typeof setTimeout);
  onTestFinished(() => frozen.mockRestore());

  // 一个订阅一条:同一个根上可以有好几个 key(仓库那一层既有整棵树的 watch,也有单层的 commonDirTopWatch)。
  // 过滤照 native backend 的样子:递归的按 key.ignore 用同一个匹配器(buildIgnoreFilter)剪,单层的只收根的直接子项。
  const subscriptions = new Set<{ accepts: (target: string) => boolean; sink: WatchSink }>();
  const watcher = createWatchService({
    backend: {
      async subscribe(key, sink, scope) {
        const ignored = buildIgnoreFilter(key.root, key.ignore);
        const accepts = key.recursive
          ? (target: string) => target.startsWith(key.root + path.sep) && !ignored(target)
          : (target: string) => path.dirname(target) === key.root;
        const subscription = { accepts, sink };
        subscriptions.add(subscription);
        scope.add(() => {
          subscriptions.delete(subscription);
        });
      },
    },
  });
  /** 做一次改动,把它在磁盘上留下的差报给订着那几个目录的 watch(在改动之后,不在改动的调用里)。 */
  const change = async <T>(root: string, run: () => Promise<T>): Promise<T> => {
    const before = await diskState(root);
    const result = await run();
    const after = await diskState(root);
    const events: WatchEvent[] = [];
    for (const [at, value] of after) if (before.get(at) !== value) events.push({ kind: 'create', path: at });
    for (const at of before.keys()) if (!after.has(at)) events.push({ kind: 'delete', path: at });
    realSetTimeout(() => {
      for (const { accepts, sink } of subscriptions) {
        const mine = events.filter((event) => accepts(event.path));
        if (mine.length > 0) sink.events(mine);
      }
    }, 0);
    return result;
  };
  return { watcher, change };
}

describe('GitWorktree', () => {
  // 这个 watch 只为「什么时候重算 git status」而存在,所以它的范围就是 git 的非忽略集。
  // 被忽略的文件不可能出现在 status 里,监听它们是可证明的浪费 —— 而在 macOS 上这份浪费
  // 是按文件数逐个开 fd 的,装了依赖的仓库直接把挂载预算烧穿。
  it('bounds the worktree watch to what git can report — ignored directories are never watched', async () => {
    const repo = await makeRepo();
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    await mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
    await mkdir(path.join(repo, 'dist'), { recursive: true });
    await writeFile(path.join(repo, 'dist', 'out.js'), 'x', 'utf8');

    const subscribed: Array<{ root: string; ignore: string[] }> = [];
    const watcher: IWatchService = {
      async nudge() {
        return false;
      },
      watch(root: string, _onEvents, options: WatchOptions = {}) {
        subscribed.push({ root, ignore: options.ignore ?? [] });
        return { ready: async () => {}, release: async () => {} };
      },
      dispose: async () => {},
    };
    const runtime = new GitRuntime({ watcher });

    try {
      const lease = await runtime.openWorktree(repo);
      const worktreeSubscription = subscribed.find((entry) => entry.root === repo);
      expect(worktreeSubscription).toBeDefined();
      expect(worktreeSubscription?.ignore).toEqual(
        expect.arrayContaining(['.git/**', 'node_modules/**', 'dist/**'])
      );
      // 跟踪中的文件照常在范围内 —— 欠近似,不能把该看的挡掉。
      // 判据必须按 glob 的**语义**问「这条路径会不会被剪掉」:所有产出都以 `/**` 结尾,
      // 所以 `not.toContain('tracked.txt')` 这种字面判断在任何实现下都为真,等于没判。
      // 产出一律是 `<目录>/**` 形态,所以「会不会被剪掉」= 有没有哪条的目录前缀盖住这条路径;
      // 形态本身变了就 fail loud —— 那时这套推理不再成立,不能让它继续默默通过。
      const ignored = (relativePath: string) =>
        (worktreeSubscription?.ignore ?? []).some((glob) => {
          if (!glob.endsWith('**')) throw new Error(`意外的 ignore glob 形态: ${glob}`);
          return relativePath.startsWith(glob.slice(0, -2));
        });
      expect(ignored('tracked.txt'), '跟踪中的文件不能被 ignore 剪掉').toBe(false);
      expect(ignored('src/tracked.txt'), '子目录里跟踪中的文件同样不能被剪掉').toBe(false);
      expect(ignored('node_modules/pkg/index.js'), '被 git 忽略的目录必须真的剪掉').toBe(true);
      await lease.release();
    } finally {
      await runtime.dispose();
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refreshes and emits worktree facts for real file and git mutations', async () => {
    const repo = await makeRepo();
    const { watcher, change } = createReplayWatchService();
    const runtime = new GitRuntime({ watcher });
    const repoUpdates: GitRepoUpdate[] = [];

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;
      const { updates, until } = recordUpdates<GitWorktreeUpdate>((listener) =>
        worktree.subscribe(listener)
      );
      worktree.repository.subscribe((update) => repoUpdates.push(update));

      await expect(worktree.getHead()).resolves.toMatchObject({
        kind: 'branch',
        name: 'main',
        oid: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      await expect(worktree.getSnapshot()).resolves.toMatchObject({
        status: { sequence: expect.any(Number), value: expect.objectContaining({ kind: 'ok' }) },
        head: {
          sequence: expect.any(Number),
          value: expect.objectContaining({
            kind: 'branch',
            name: 'main',
            oid: expect.stringMatching(/^[0-9a-f]{40}$/),
          }),
        },
      });
      await expect(worktree.getStatusFingerprint('normal')).resolves.toMatchObject({
        byteLength: expect.any(Number),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      await expect(worktree.isFileCleanlyTracked('tracked.txt')).resolves.toBe(true);
      await change(repo, () => writeFile(path.join(repo, 'tracked.txt'), 'after\n', 'utf8'));

      // Wait for a pushed status model that reflects the modification (subscribe also
      // pushes an initial clean status, so matching on kind alone would race).
      await until(
        'status push shows tracked.txt unstaged',
        (update) =>
          update.kind === 'status' &&
          update.model.kind === 'ok' &&
          update.model.unstaged.some((change) => change.path === repoFile(repo, 'tracked.txt'))
      );
      await expect(worktree.isFileCleanlyTracked('tracked.txt')).resolves.toBe(false);
      const changedStatus = await worktree.getStatus();
      expect(changedStatus).toMatchObject({
        kind: 'ok',
        unstaged: [
          expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
        ],
      });
      expect(changedStatus).not.toHaveProperty('currentBranch');
      expect(changedStatus).not.toHaveProperty('headKind');
      expect(changedStatus).not.toHaveProperty('shortHash');

      await expect(worktree.getFileAtRef('tracked.txt', 'HEAD')).resolves.toBe('before\n');
      await expect(worktree.getChangedFiles({ kind: 'head' })).resolves.toEqual([
        expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
      ]);

      const stageSequences = expectSuccess(await worktree.stage(['tracked.txt']));
      expect(stageSequences.status).toBeGreaterThanOrEqual(1);
      const snapshotAfterStage = await worktree.getSnapshot();
      expect(snapshotAfterStage.status.sequence).toBeGreaterThanOrEqual(stageSequences.status!);
      expect(await worktree.getStatus()).toMatchObject({
        kind: 'ok',
        staged: [
          expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
        ],
        unstaged: [],
        stagedAdded: 1,
        stagedDeleted: 1,
      });
      expect(await worktree.getStatus()).not.toHaveProperty('totalAdded');
      expect(await worktree.getStatus()).not.toHaveProperty('totalDeleted');
      await expect(worktree.getFileAtIndex('tracked.txt')).resolves.toBe('after\n');
      await expect(worktree.getChangedFiles({ kind: 'staged' })).resolves.toEqual([
        expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
      ]);

      const commit = await worktree.commit('change tracked');
      expect(commit.success).toBe(true);
      if (!commit.success) throw new Error(commit.error.message);
      expect(commit.data.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.data.sequences).toMatchObject({
        status: expect.any(Number),
        head: expect.any(Number),
        refs: expect.any(Number),
      });
      const snapshotAfterCommit = await worktree.getSnapshot();
      expect(snapshotAfterCommit.head.sequence).toBeGreaterThan(snapshotAfterStage.head.sequence);
      expect(snapshotAfterCommit.head.value).toEqual({
        kind: 'branch',
        name: 'main',
        oid: commit.data.hash,
      });
      await execFileAsync('git', ['tag', 'v-change', commit.data.hash], { cwd: repo });
      expect(await worktree.getStatus()).toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: [],
      });
      await expect(worktree.getLog({ maxCount: 1 })).resolves.toMatchObject({
        aheadCount: 0,
        commits: [
          expect.objectContaining({
            hash: commit.data.hash,
            isPushed: false,
            subject: 'change tracked',
            tags: ['v-change'],
          }),
        ],
      });
      await expect(worktree.getCommitFiles(commit.data.hash)).resolves.toEqual([
        expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
      ]);

      expect(updates.some((update) => update.kind === 'head')).toBe(true);
      expect(repoUpdates.some((update) => update.kind === 'refs')).toBe(true);
      await lease.release();
    } finally {
      await runtime.dispose();
      await watcher.dispose();
    }
  });

  it('refreshes staged status when an external commit advances the branch ref', async () => {
    const repo = await makeRepo();
    const { watcher, change } = createReplayWatchService();
    const runtime = new GitRuntime({ watcher });

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;
      const { updates, until } = recordUpdates<GitWorktreeUpdate>((listener) =>
        worktree.subscribe(listener)
      );

      await change(repo, async () => {
        await writeFile(path.join(repo, 'tracked.txt'), 'external\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
      });

      await until(
        'status push shows tracked.txt staged',
        (update) =>
          update.kind === 'status' &&
          update.model.kind === 'ok' &&
          update.model.staged.some((change) => change.path === repoFile(repo, 'tracked.txt'))
      );
      updates.length = 0;

      await change(repo, () => execFileAsync('git', ['commit', '-m', 'external commit'], { cwd: repo }));

      await until(
        'status push shows a clean worktree after the external commit',
        (update) =>
          update.kind === 'status' &&
          update.model.kind === 'ok' &&
          update.model.staged.length === 0 &&
          update.model.unstaged.length === 0
      );

      await expect(worktree.getStatus()).resolves.toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: [],
      });

      await lease.release();
    } finally {
      await runtime.dispose();
      await watcher.dispose();
    }
  });

  it('refreshes staged status when an external merge continuation commits resolved files', async () => {
    const repo = await makeRepo();
    await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: repo });
    await writeFile(path.join(repo, 'tracked.txt'), 'feature\n', 'utf8');
    await execFileAsync('git', ['commit', '-am', 'feature edit'], { cwd: repo });
    await execFileAsync('git', ['checkout', 'main'], { cwd: repo });
    await writeFile(path.join(repo, 'tracked.txt'), 'main\n', 'utf8');
    await execFileAsync('git', ['commit', '-am', 'main edit'], { cwd: repo });
    await execFileAsync('git', ['checkout', 'feature'], { cwd: repo });

    const { watcher, change } = createReplayWatchService();
    const runtime = new GitRuntime({ watcher });

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;
      const { updates, until } = recordUpdates<GitWorktreeUpdate>((listener) =>
        worktree.subscribe(listener)
      );

      await change(repo, async () => {
        await expect(execFileAsync('git', ['merge', 'main'], { cwd: repo })).rejects.toThrow();
        await writeFile(path.join(repo, 'tracked.txt'), 'resolved\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
      });

      await until(
        'status push shows tracked.txt staged',
        (update) =>
          update.kind === 'status' &&
          update.model.kind === 'ok' &&
          update.model.staged.some((change) => change.path === repoFile(repo, 'tracked.txt'))
      );
      updates.length = 0;

      await change(repo, () =>
        execFileAsync('git', ['merge', '--continue'], {
          cwd: repo,
          env: { ...process.env, GIT_EDITOR: 'true' },
        })
      );

      await until(
        'status push shows a clean worktree after merge --continue',
        (update) =>
          update.kind === 'status' &&
          update.model.kind === 'ok' &&
          update.model.staged.length === 0 &&
          update.model.unstaged.length === 0
      );

      await expect(worktree.getStatus()).resolves.toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: [],
      });

      await lease.release();
    } finally {
      await runtime.dispose();
      await watcher.dispose();
    }
  });

  it('computes pushed log state and refreshes refs after push', async () => {
    const { repo } = await makeRepoWithRemote();
    await writeFile(path.join(repo, 'tracked.txt'), 'pushed\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });

    const watcher = createNativeWatchService();
    const runtime = new GitRuntime({ watcher });
    const repoUpdates: string[] = [];

    try {
      const lease = await runtime.openWorktree(repo);
      lease.value.repository.subscribe((update) => repoUpdates.push(update.kind));
      const commit = await lease.value.commit('push me');
      expect(commit.success).toBe(true);
      if (!commit.success) throw new Error(commit.error.message);

      expect((await lease.value.repository.getRefs()).branches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branch: 'main',
            divergence: { ahead: 1, behind: 0 },
            type: 'local',
          }),
        ])
      );

      repoUpdates.length = 0;
      await expect(lease.value.push()).resolves.toMatchObject({ success: true });
      expect(repoUpdates).toContain('refs');
      await expect(lease.value.getLog({ maxCount: 1 })).resolves.toMatchObject({
        aheadCount: 0,
        commits: [expect.objectContaining({ hash: commit.data.hash, isPushed: true })],
      });
      expect((await lease.value.repository.getRefs()).branches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            branch: 'main',
            type: 'local',
          }),
        ])
      );
      await lease.release();
    } finally {
      await runtime.dispose();
      await watcher.dispose();
    }
  });

  it('keeps leased worktrees usable when runtime disposal is requested', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();
    const lease = await runtime.openWorktree(repo);

    const dispose = runtime.dispose();

    await expect(lease.value.getStatus()).resolves.toMatchObject({ kind: 'ok' });
    await expect(runtime.openWorktree(repo)).rejects.toThrow('GitRuntime disposed');
    await lease.release();
    await dispose;
  });

  it('reads image bytes from git refs as serializable data URLs', async () => {
    const repo = await makeRepo();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
      'base64'
    );
    await writeFile(path.join(repo, 'pixel.png'), png);
    await execFileAsync('git', ['add', 'pixel.png'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'add pixel'], { cwd: repo });

    const watcher = createNativeWatchService();
    const runtime = new GitRuntime({ watcher });
    try {
      const lease = await runtime.openWorktree(repo);
      await expect(lease.value.getImageAtRef('pixel.png', 'HEAD')).resolves.toMatchObject({
        kind: 'image',
        image: {
          mimeType: 'image/png',
          size: png.length,
          dataUrl: expect.stringContaining('data:image/png;base64,'),
        },
      });
      await lease.release();
    } finally {
      await runtime.dispose();
      await watcher.dispose();
    }
  });

  it('models unexpected status failures instead of reporting a clean tree', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();

    try {
      const lease = await runtime.openWorktree(repo);
      await rm(path.join(repo, '.git'), { force: true, recursive: true });

      await expect(lease.value.getStatus()).resolves.toMatchObject({
        kind: 'error',
        message: expect.stringContaining('not a git repository'),
      });
      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });

  it('stageAll, unstageAll, and revertAll mutate the full worktree state', async () => {
    const repo = await makeRepo();
    const watcher = createNativeWatchService();
    const runtime = new GitRuntime({ watcher });

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;

      await writeFile(path.join(repo, 'tracked.txt'), 'modified\n', 'utf8');
      await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');
      await writeFile(path.join(repo, 'to-delete.txt'), 'gone\n', 'utf8');
      await execFileAsync('git', ['add', 'to-delete.txt'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'add to-delete'], { cwd: repo });
      await rm(path.join(repo, 'to-delete.txt'));

      const stageAllSequences = expectSuccess(await worktree.stageAll());
      expect(stageAllSequences.status).toBeGreaterThanOrEqual(1);
      expect(await worktree.getStatus()).toMatchObject({
        kind: 'ok',
        staged: expect.arrayContaining([
          expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
          expect.objectContaining({ path: repoFile(repo, 'untracked.txt'), status: 'added' }),
          expect.objectContaining({ path: repoFile(repo, 'to-delete.txt'), status: 'deleted' }),
        ]),
        unstaged: [],
      });

      const unstageAllSequences = expectSuccess(await worktree.unstageAll());
      expect(unstageAllSequences.status).toBeGreaterThanOrEqual(1);
      expect(await worktree.getStatus()).toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: expect.arrayContaining([
          expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
          expect.objectContaining({
            path: repoFile(repo, 'untracked.txt'),
            status: 'added',
            additions: 1,
            deletions: 0,
          }),
          expect.objectContaining({ path: repoFile(repo, 'to-delete.txt'), status: 'deleted' }),
        ]),
      });

      const revertAllSequences = expectSuccess(await worktree.revertAll());
      expect(revertAllSequences.status).toBeGreaterThanOrEqual(1);
      expect(await worktree.getStatus()).toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: [],
      });
      expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('before\n');
      expect(await readFile(path.join(repo, 'to-delete.txt'), 'utf8')).toBe('gone\n');
      await expect(readFile(path.join(repo, 'untracked.txt'), 'utf8')).rejects.toThrow();

      await lease.release();
    } finally {
      await runtime.dispose();
      await watcher.dispose();
    }
  });

  it('counts untracked file additions without a trailing newline', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();

    try {
      const lease = await runtime.openWorktree(repo);
      await writeFile(path.join(repo, 'untracked.txt'), 'new', 'utf8');

      await expect(lease.value.getStatus()).resolves.toMatchObject({
        kind: 'ok',
        unstaged: expect.arrayContaining([
          expect.objectContaining({
            path: repoFile(repo, 'untracked.txt'),
            status: 'added',
            additions: 1,
            deletions: 0,
          }),
        ]),
      });

      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });

  it('reverts selected working tree changes while removing selected untracked files', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;

      await writeFile(path.join(repo, 'tracked.txt'), 'modified\n', 'utf8');
      await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');

      const sequences = expectSuccess(await worktree.revert(['tracked.txt', 'untracked.txt']));

      expect(sequences.status).toBeGreaterThanOrEqual(1);
      await expect(worktree.getStatus()).resolves.toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: [],
      });
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
      await expect(readFile(path.join(repo, 'untracked.txt'), 'utf8')).rejects.toThrow();

      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });

  it('reverts selected working tree changes without discarding staged content', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;

      await writeFile(path.join(repo, 'tracked.txt'), 'staged\n', 'utf8');
      expectSuccess(await worktree.stage(['tracked.txt']));
      await writeFile(path.join(repo, 'tracked.txt'), 'unstaged\n', 'utf8');

      const sequences = expectSuccess(await worktree.revert(['tracked.txt']));

      expect(sequences.status).toBeGreaterThanOrEqual(1);
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('staged\n');
      await expect(worktree.getStatus()).resolves.toMatchObject({
        kind: 'ok',
        staged: [
          expect.objectContaining({ path: repoFile(repo, 'tracked.txt'), status: 'modified' }),
        ],
        unstaged: [],
      });

      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });

  it('reverts selected files staged for deletion without deleting the working copy', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;

      await execFileAsync('git', ['rm', '--cached', 'tracked.txt'], { cwd: repo });

      const sequences = expectSuccess(await worktree.revert(['tracked.txt']));

      expect(sequences.status).toBeGreaterThanOrEqual(1);
      await expect(readFile(path.join(repo, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
      await expect(worktree.getStatus()).resolves.toMatchObject({
        kind: 'ok',
        staged: [],
        unstaged: [],
      });

      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });

  it('refreshes staged status when the index blob changes but summary fields stay equal', async () => {
    const repo = await makeRepo();
    const runtime = new GitRuntime();

    try {
      const lease = await runtime.openWorktree(repo);
      const worktree = lease.value;

      await writeFile(path.join(repo, 'tracked.txt'), 'two\n', 'utf8');
      const firstSequences = expectSuccess(await worktree.stage(['tracked.txt']));
      const firstStatus = await worktree.getStatus();
      if (firstStatus.kind !== 'ok') throw new Error('Expected ok status');
      const firstChange = firstStatus.staged[0];
      expect(firstChange).toMatchObject({
        path: repoFile(repo, 'tracked.txt'),
        status: 'modified',
        additions: 1,
        deletions: 1,
        indexOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      });

      await writeFile(path.join(repo, 'tracked.txt'), 'too\n', 'utf8');
      const secondSequences = expectSuccess(await worktree.stage(['tracked.txt']));
      const secondStatus = await worktree.getStatus();
      if (secondStatus.kind !== 'ok') throw new Error('Expected ok status');
      const secondChange = secondStatus.staged[0];

      expect(secondSequences.status).toBeGreaterThan(firstSequences.status!);
      expect(secondChange).toMatchObject({
        path: repoFile(repo, 'tracked.txt'),
        status: 'modified',
        additions: 1,
        deletions: 1,
        indexOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      expect(secondChange?.indexOid).not.toBe(firstChange?.indexOid);
      await expect(worktree.getFileAtIndex('tracked.txt')).resolves.toBe('too\n');

      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });

  it('unstageAll and revertAll tolerate unborn HEAD', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'emdash-shared-worktree-unborn-'));
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
    await writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');

    const runtime = new GitRuntime();
    try {
      const lease = await runtime.openWorktree(repo);
      await writeFile(path.join(repo, 'extra.txt'), 'bar\n', 'utf8');

      const unstageSequences = expectSuccess(await lease.value.unstageAll());
      expect(unstageSequences.status).toBeGreaterThanOrEqual(1);

      const revertSequences = expectSuccess(await lease.value.revertAll());
      expect(revertSequences.status).toBeGreaterThanOrEqual(1);
      await expect(readFile(path.join(repo, 'untracked.txt'), 'utf8')).rejects.toThrow();
      await expect(readFile(path.join(repo, 'extra.txt'), 'utf8')).rejects.toThrow();

      await lease.release();
    } finally {
      await runtime.dispose();
    }
  });
});
