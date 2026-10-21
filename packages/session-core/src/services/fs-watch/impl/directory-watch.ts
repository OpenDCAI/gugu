import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IDisposable } from '@gugu/session-shared';
import type { WatchEvent } from '../api';
import { MAX_RESUBSCRIBE_DELAY_MS, RESUBSCRIBE_DELAY_MS } from './native-watch';

/**
 * 单层目录监听：只报这一层的直接子项。
 *
 * 为什么不用 @parcel/watcher：它只会递归(Options 里只有 ignore / backend,没有深度)。
 * 而懒展开的树只需要「已展开目录的直接子项」——递归监听整棵树在 macOS 上要按未忽略
 * entry 数逐个开 fd,监听根是用户挑的目录(可以是家目录),代价没有上界。
 *
 * node 的 `fs.watch(dir, { recursive: false })` 就是现成的单目录原语,每个目录一个句柄,
 * 代价与目录里有多少个后代无关。
 *
 * 与 NativeWatch 同构的一点:句柄失效要能自愈。目录被删了又建(切分支、重装依赖)时,底层
 * 句柄挂在旧 inode 上,内核不再送事件 —— 若只记一条日志,这一层就**永久**不再更新。所以
 * 出错即退避重订,重订成功必须 resync:中间那段时间的事件是真丢了,消费者得重列一次。
 */
export class DirectoryWatch implements IDisposable {
  readonly root: string;
  private readonly deliver: (events: WatchEvent[]) => void;
  private readonly resync: () => void;
  private readonly onError: (context: string, error: unknown) => void;
  private watcher: FSWatcher | null = null;
  private readyPromise: Promise<void>;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempts = 0;
  private disposed = false;

  constructor(
    root: string,
    deliver: (events: WatchEvent[]) => void,
    resync: () => void,
    onError: (context: string, error: unknown) => void
  ) {
    this.root = root;
    this.deliver = deliver;
    this.resync = resync;
    this.onError = onError;
    this.readyPromise = this.start();
    this.readyPromise.catch(() => {});
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.readyPromise.catch(() => {});
    this.closeWatcher();
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private async start(): Promise<void> {
    // 目录不在就 fail loud —— 静默变成一个永不触发的监听,比报错难查得多。
    await fs.stat(this.root);
    if (this.disposed) return;
    this.attach();
  }

  private attach(): void {
    const watcher = fsWatch(this.root, { recursive: false, persistent: false });
    watcher.on('change', (eventType, filename) => {
      if (this.disposed || filename === null || filename === undefined) return;
      const name = typeof filename === 'string' ? filename : filename.toString();
      if (!name) return;
      const absPath = path.join(this.root, name);
      // fs.watch 只给 rename/change,不区分建/删；rename 到底是哪一种要看当下还在不在。
      const kind: WatchEvent['kind'] =
        eventType === 'change' ? 'update' : existsSync(absPath) ? 'create' : 'delete';
      this.deliver([{ kind, path: absPath }]);
    });
    watcher.on('error', (error) => {
      if (this.disposed) return;
      this.onError(`watch ${this.root}`, error);
      this.closeWatcher();
      this.scheduleReattach();
    });
    this.watcher = watcher;
    this.retryAttempts = 0;
  }

  private scheduleReattach(): void {
    if (this.retryTimer || this.disposed) return;
    const delay = Math.min(
      RESUBSCRIBE_DELAY_MS * 2 ** this.retryAttempts,
      MAX_RESUBSCRIBE_DELAY_MS
    );
    this.retryAttempts += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reattach();
    }, delay);
  }

  private async reattach(): Promise<void> {
    if (this.disposed) return;
    try {
      await fs.stat(this.root);
    } catch (error) {
      // 目录还没回来(或已经真没了)——继续退避重试;scope 释放时 dispose 会停掉它。
      this.onError(`reattach ${this.root}`, error);
      this.scheduleReattach();
      return;
    }
    if (this.disposed) return;
    try {
      this.attach();
    } catch (error) {
      this.onError(`reattach ${this.root}`, error);
      this.scheduleReattach();
      return;
    }
    // 断开期间的事件是真丢了,只有重列一次才能对上账。
    try {
      this.resync();
    } catch (error) {
      this.onError(`resync ${this.root}`, error);
    }
  }
}
