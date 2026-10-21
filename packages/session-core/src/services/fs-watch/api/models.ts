export type WatchEventKind = 'create' | 'update' | 'delete';

export type WatchEvent = {
  kind: WatchEventKind;
  path: string;
};

export type WatchOptions = {
  /**
   * Native-level ignore globs, a property of the shared root subscription: consumers watching
   * the same root should agree on the ignore set to share one native watcher (different sets
   * create separate subscriptions). Relevance filtering beyond ignores belongs in consumers.
   */
  ignore?: string[];
  /**
   * false = 只看这一层目录的直接子项。
   *
   * 懒展开的树型 UI 只渲染「已展开目录的直接子项」,却递归监听整棵树 —— 这是范畴错误,
   * 而且不是免费的：macOS 上可用的 backend 按未忽略 entry 数逐个开 fd,监听根又是用户
   * 挑的目录(可以是家目录),大小没有上界。需要深处变化的消费者自己按层订阅。
   */
  recursive?: boolean;
  /**
   * 整棵树,但粗粒度也行:事件可能只有一次 resync(git status、App 的 files:read 这类本来就会整体重算的)。
   * 一个目录一个 watch 的平台(Linux inotify)上,整棵树的订阅只收「被单层盯着的目录」的事件;
   * coarse 的另外在 nudge 时收一次 resync,补上没人盯着的那些目录。非 coarse 的(打开着的文件那条变化流)
   * 不收 nudge —— 对它来说 resync 意味着重载预览、重读所有页签,只该在事件真丢了的时候发生。
   */
  coarse?: boolean;
  debounceMs?: number;
  /**
   * Called when the native watcher reports an event gap, after a native resubscribe, or after a
   * subprocess-backed watcher reconnects. Events may have been lost; consumers should treat all
   * derived state as stale and resync.
   */
  onResync?: () => void;
};

export type WatchHandle = {
  ready(): Promise<void>;
  release(): Promise<void>;
};

export type IWatchService = {
  watch(
    root: string,
    onEvents: (events: WatchEvent[]) => void,
    options?: WatchOptions
  ): WatchHandle;
  /** 见 WatchBackend.nudge:返回这一下有没有兑现。 */
  nudge(root?: string): Promise<boolean>;
  dispose(): Promise<void>;
};
