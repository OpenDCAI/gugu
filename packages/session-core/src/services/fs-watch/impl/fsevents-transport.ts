import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import type { AsyncSubscription, Event as ParcelEvent, Options } from '@parcel/watcher';
import { buildIgnoreFilter } from './paths';

/**
 * darwin 上的原生传输：直接绑 FSEvents,不走 @parcel/watcher。
 *
 * 为什么换：@parcel/watcher 在 darwin 上只有 kqueue 可用（它的 FSEvents 后端在最后一个订阅被
 * 移除时销毁共享 backend,派生析构先放掉 run loop、基类才 join 线程 —— #3051/#3061,产品侧
 * 由 #3318 加围栏兜着,上游至今未修:parcel-bundler/watcher#259）。而 kqueue 没有递归监听,
 * 要为每个未忽略文件各开一个 fd,于是「监听一个目录」的代价由用户磁盘里有多少东西决定,
 * 没有上界（实测 1,600,882 entry 的仓:kqueue 456ms/6,052 fd,FSEvents 1ms/10 fd）。
 *
 * fsevents 每次 watch 返回独立 instance,stop 只作用于自己那个 —— 没有共享 backend 引用计数
 * 归零销毁,也没有基类/派生类分管线程与资源,上述触发条件不成立。
 */

/** FSEvents 的标志位（fsevents.constants 的子集,只取本模块判读要用的）。 */
type FseventsInfo = {
  event: 'created' | 'modified' | 'deleted' | 'moved' | 'root-changed' | 'cloned' | 'unknown';
};

type FseventsModule = {
  watch(target: string, handler: (eventPath: string, flags: number) => void): () => Promise<void>;
  getInfo(eventPath: string, flags: number): FseventsInfo;
  constants: Record<string, number>;
};

/**
 * 攒批再回调。原生层每个路径一次回调,而消费者按批处理；不攒批的话一次 `pnpm install`
 * 会把 JS 线程打满。25ms 取自 @parcel/watcher 自身 Debounce 的同量级。
 */
export const FSEVENTS_BATCH_MS = 25;

/** 与 `requiresResync()` 对齐:事件可能丢了,消费者必须整体重扫。 */
const RESCAN_MESSAGE = 'Events were dropped by the FSEvents client. File system must be re-scanned.';

let cached: FseventsModule | null | undefined;

function loadFsevents(): FseventsModule | null {
  if (cached !== undefined) return cached;
  try {
    // fsevents 是 darwin-only 的 optional dependency,其它平台上根本不会被安装 —— 静态 import
    // 会让 Linux/Windows 直接加载失败,所以这里按需 require。
    const require = createRequire(import.meta.url);
    cached = require('fsevents') as FseventsModule;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * FSEvents 的标志位是路径级累积量,不是操作流水:`getEventType` 按
 * 删除 > 重命名 > 创建 > 修改 取首个命中,所以「改一个近期创建过的文件」会报成 created。
 *
 * 我们不为此重建目录快照做差分 —— 那正是本次要甩掉的结构。抽查过消费点,代价是多做一次重列
 * 而不是算错:`file-tree` 只把 update 当可跳过的优化,`changes` 只对 delete 分支,而删除
 * 优先级最高、映射准确。
 *
 * moved 无法从标志位判断方向,用一次 stat 定夺 —— 只有重命名会走到这条路径。
 */
async function toParcelEvent(eventPath: string, event: FseventsInfo['event']): Promise<ParcelEvent> {
  switch (event) {
    case 'deleted':
      return { path: eventPath, type: 'delete' };
    case 'created':
      return { path: eventPath, type: 'create' };
    case 'moved': {
      const exists = await stat(eventPath).then(
        () => true,
        () => false
      );
      return { path: eventPath, type: exists ? 'create' : 'delete' };
    }
    default:
      return { path: eventPath, type: 'update' };
  }
}

export type FseventsSubscribe = (
  root: string,
  callback: (err: Error | null, events: ParcelEvent[]) => unknown,
  options?: Options
) => Promise<AsyncSubscription>;

export function createFseventsSubscribe(load: () => FseventsModule | null = loadFsevents): FseventsSubscribe {
  return async function subscribe(root, callback, options) {
    const fsevents = load();
    if (!fsevents) throw new Error('fsevents is unavailable on this platform');

    const mustScanSubDirs = fsevents.constants.MustScanSubDirs ?? 0;
    const rootChanged = fsevents.constants.RootChanged ?? 0;
    const shouldIgnore = buildIgnoreFilter(root, options?.ignore);

    let disposed = false;
    let pending: ParcelEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    /**
     * resync 之前的增量在重扫后一律作废。用代次作废而不是只清队列,是因为 moved 那条路要 stat,
     * 事件可能还在飞 —— 只清队列的话它们落地时又会把陈旧 delta 叠回刚扫出来的状态。
     */
    let generation = 0;

    const discardPending = () => {
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = [];
    };

    const flush = () => {
      timer = null;
      if (disposed || pending.length === 0) return;
      const batch = pending;
      pending = [];
      callback(null, batch);
    };

    const stop = fsevents.watch(root, (eventPath, flags) => {
      if (disposed) return;

      // 事件被丢弃过 / 根本身变了 —— 派生状态一律作废。复用 @parcel/watcher 的原文,
      // 好让既有的 requiresResync() 照常命中,不必在两处维护同一个判据。
      if ((flags & mustScanSubDirs) !== 0 || (flags & rootChanged) !== 0) {
        discardPending();
        callback(new Error(RESCAN_MESSAGE), []);
        return;
      }

      if (shouldIgnore(eventPath)) return;

      const issuedAt = generation;
      void toParcelEvent(eventPath, fsevents.getInfo(eventPath, flags).event).then(
        (event) => {
          if (disposed || issuedAt !== generation) return;
          pending.push(event);
          if (!timer) timer = setTimeout(flush, FSEVENTS_BATCH_MS);
        },
        (error: unknown) => {
          if (disposed || issuedAt !== generation) return;
          callback(error instanceof Error ? error : new Error(String(error)), []);
        }
      );
    });

    return {
      unsubscribe: async () => {
        if (disposed) return;
        disposed = true;
        discardPending();
        await stop();
      },
    };
  };
}
