import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createScope } from '@gugu/session-wire/util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WatchEvent } from '../api';
import type { WatchKey, WatchSink } from './backend';
import { nativeWatchBackend } from './native-backend';

/** 一个 sink:记下收到的事件和 resync 次数。 */
function recordingSink() {
  const events: WatchEvent[] = [];
  let resyncs = 0;
  const sink: WatchSink = {
    events: (batch) => {
      events.push(...batch);
    },
    resync: () => {
      resyncs += 1;
    },
  };
  return { sink, events, resyncs: () => resyncs };
}

/**
 * 单层目录监听由测试扮演:按目录记下 deliver,由用例按 inotify 的报法交事件。真 fs.watch 在 macOS 上也走 fseventsd,
 * 负载下晚几分钟或干脆不送(#7371),而这里判的是「整棵树的订阅收哪些目录的事件」,不是投递。
 */
function directoryWatches() {
  const byRoot = new Map<string, (events: WatchEvent[]) => void>();
  return {
    directory: (root: string, deliver: (events: WatchEvent[]) => void) => {
      byRoot.set(root, deliver);
      return { ready: async () => {}, dispose: async () => void byRoot.delete(root) };
    },
    /** inotify 在那个目录上报了一个名字。 */
    saw: (dir: string, event: WatchEvent) => byRoot.get(dir)!([event]),
  };
}


const key = (root: string, over: Partial<WatchKey> = {}): WatchKey => ({ root, ignore: [], recursive: true, coarse: false, ...over });

// @@@tree-by-directories:一个目录一个 watch 的平台上,整棵树的订阅只收「被单层盯着的目录」的事件,
// coarse 的另外在 nudge 时收 resync。用 platform 选项按 Linux 的兑现方式跑(DirectoryWatch 在哪个平台都是 fs.watch)。
describe('nativeWatchBackend on a one-watch-per-directory platform', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'gugu-tree-by-dirs-')));
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('a whole-tree subscription hears the directories someone watches, minus its own ignores', async () => {
    const watches = directoryWatches();
    const backend = nativeWatchBackend({
      platform: 'linux',
      directory: watches.directory,
      // 一个目录一个 watch 的平台上,整棵树的订阅不开递归监听(父提交的递归监听会看见没人盯着的 deep/)。
      subscribe: async () => {
        throw new Error('a whole-tree subscription opened a recursive watch');
      },
    });
    const scope = createScope({ label: 'test' });
    const feed = recordingSink();
    const git = recordingSink();
    await backend.subscribe(key(root, { ignore: ['**/node_modules/**'] }), feed.sink, scope);
    await backend.subscribe(key(root, { ignore: ['dist/**'], coarse: true }), git.sink, scope);
    // 打开着的文件所在的目录:dist/ 与 node_modules/x
    const dist = path.join(root, 'dist');
    const x = path.join(root, 'node_modules', 'x');
    await backend.subscribe(key(dist, { recursive: false }), recordingSink().sink, scope);
    await backend.subscribe(key(x, { recursive: false }), recordingSink().sink, scope);

    const outTxt = path.join(dist, 'out.txt');
    const iJs = path.join(x, 'i.js');
    watches.saw(dist, { kind: 'create', path: outTxt });
    watches.saw(x, { kind: 'create', path: iJs });

    expect(feed.events).toEqual([{ kind: 'create', path: outTxt }]);
    expect(git.events).toEqual([{ kind: 'create', path: iJs }]);
    await scope.dispose();
  });

  it('nudge reaches only the coarse whole-tree subscriptions under the root', async () => {
    const backend = nativeWatchBackend({ platform: 'linux' });
    const scope = createScope({ label: 'test' });
    const feed = recordingSink();
    const git = recordingSink();
    const elsewhere = recordingSink();
    await backend.subscribe(key(root), feed.sink, scope);
    await backend.subscribe(key(root, { coarse: true }), git.sink, scope);
    await backend.subscribe(key(path.join(tmpdir(), 'gugu-not-this-root'), { coarse: true }), elsewhere.sink, scope);

    expect(await backend.nudge?.(root)).toBe(true);
    expect([feed.resyncs(), git.resyncs(), elsewhere.resyncs()]).toEqual([0, 1, 0]);
    expect(await backend.nudge?.()).toBe(true);
    expect([feed.resyncs(), git.resyncs(), elsewhere.resyncs()]).toEqual([0, 2, 1]);
    // 这个根下面没有按目录兑现的订阅:什么都不缺,调用方别跟着做重活。
    expect(await backend.nudge?.(path.join(tmpdir(), 'gugu-nobody-here'))).toBe(false);
    await scope.dispose();
  });

  // 一个根就看得到整棵树的平台:nudge 从不兑现,调用方因此什么都不多做(与改动前逐字一致)。
  it('never honors a nudge on a platform whose one root sees the whole tree', async () => {
    const backend = nativeWatchBackend({ platform: 'darwin', subscribe: async () => ({ unsubscribe: async () => {} }) });
    const scope = createScope({ label: 'test' });
    await backend.subscribe(key(root, { coarse: true }), recordingSink().sink, scope);
    expect(await backend.nudge?.(root)).toBe(false);
    await scope.dispose();
  });
});
