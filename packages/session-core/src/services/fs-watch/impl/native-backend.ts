import path from 'node:path';
import type { WatchEvent } from '../api';
import type { WatchBackend, WatchOnError, WatchSink } from './backend';
import { DirectoryWatch } from './directory-watch';
import { NativeWatch, type ParcelSubscribeFn } from './native-watch';
import { buildIgnoreFilter } from './paths';

export type NativeWatchBackendOptions = {
  onError?: WatchOnError;
  subscribe?: ParcelSubscribeFn;
  /** 测试用:按哪个平台兑现整棵树的订阅。默认 process.platform。 */
  platform?: NodeJS.Platform;
  /** 测试用:单层目录监听。默认 DirectoryWatch(node fs.watch;macOS 上它也走 fseventsd)。 */
  directory?: (
    root: string,
    deliver: (events: WatchEvent[]) => void,
    resync: () => void,
    onError: WatchOnError
  ) => { ready(): Promise<void>; dispose(): Promise<void> };
};

/** 一个按目录兑现的整棵树订阅(Linux):它下面哪些目录被单层盯着,它就收哪些目录的事件。 */
type DirectoryBackedTree = { root: string; coarse: boolean; ignored: (target: string) => boolean; sink: WatchSink };

export function nativeWatchBackend(options: NativeWatchBackendOptions = {}): WatchBackend {
  const onError = options.onError ?? (() => {});
  /**
   * @@@tree-by-directories — Linux 的 inotify 一个 watch 只看一个目录,整棵树就得一个目录一个 watch,
   * 数量跟着仓库走,撞上 max_user_watches 就整个订阅失效。所以在 Linux 上整棵树的订阅**不再遍历**:
   * 它收的是落在它下面、本来就被单层盯着的那些目录的事件(打开着的文件、展开着的目录 —— 消费者各自
   * 报的兴趣);声明了 coarse 的,另外在 nudge 时收一次 resync。消费者只说「我要整棵树(粗一点可以)」,不知道下面是
   * 哪个平台;FSEvents / ReadDirectoryChangesW 一个根就看得到整棵树,照旧走原生递归。
   */
  const byDirectories = (options.platform ?? process.platform) === 'linux';
  const trees = new Set<DirectoryBackedTree>();
  const within = (target: string, root: string) => target === root || target.startsWith(root + path.sep);

  const forwardToTrees = (events: WatchEvent[]) => {
    for (const tree of trees) {
      const mine = events.filter((event) => within(event.path, tree.root) && !tree.ignored(event.path));
      if (mine.length > 0) tree.sink.events(mine);
    }
  };

  return {
    async subscribe(key, sink, scope) {
      // 单层订阅走 node 的 fs.watch：@parcel/watcher 只会递归,拿它做单层等于把整棵树的
      // 代价付一遍(见 DirectoryWatch 的注释)。
      if (!key.recursive) {
        // ignore 是 watch key 的一维,这里若默默丢掉,调用方拿到的是一个「声明了剪枝、
        // 实际没剪」的订阅,而且两个只差 ignore 的 key 会各开一个完全一样的句柄。
        // 单层监听目前没有实现 glob 剪枝(fs.watch 不接受 ignore),所以只能挑明。
        if (key.ignore.length > 0) {
          throw new Error(
            `non-recursive watch does not support ignore globs (${key.root}: ${key.ignore.join(', ')})`
          );
        }
        const deliver = byDirectories
          ? (events: WatchEvent[]) => {
              sink.events(events);
              forwardToTrees(events);
            }
          : sink.events;
        const directory = (options.directory ?? ((...args) => new DirectoryWatch(...args)))(key.root, deliver, sink.resync, onError);
        scope.add(() => directory.dispose());
        await directory.ready();
        return;
      }
      if (byDirectories) {
        const tree: DirectoryBackedTree = {
          root: key.root,
          coarse: key.coarse,
          ignored: buildIgnoreFilter(key.root, key.ignore),
          sink,
        };
        trees.add(tree);
        scope.add(() => {
          trees.delete(tree);
        });
        return;
      }
      const native = new NativeWatch(
        key.root,
        key.ignore,
        sink.events,
        sink.resync,
        onError,
        options.subscribe
      );
      scope.add(() => native.dispose());
      await native.ready();
    },
    nudge(root) {
      let honored = false;
      for (const tree of trees) {
        if (root !== undefined && !within(tree.root, root) && !within(root, tree.root)) continue;
        honored = true;
        if (tree.coarse) tree.sink.resync();
      }
      return honored;
    },
  };
}
