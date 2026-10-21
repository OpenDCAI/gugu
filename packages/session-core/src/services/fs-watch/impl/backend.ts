import type { Scope } from '@gugu/session-wire/util';
import type { WatchEvent } from '../api';

export type WatchKey = {
  root: string;
  ignore: string[];
  /** false = 只订这一层目录的直接子项(见 WatchOptions.recursive)。 */
  recursive: boolean;
  /** 整棵树、粗粒度也行(见 WatchOptions.coarse)。 */
  coarse: boolean;
};

export type WatchSink = {
  events(events: WatchEvent[]): void;
  resync(): void;
};

export type WatchOnError = (context: string, error: unknown) => void;

export interface WatchBackend {
  subscribe(key: WatchKey, sink: WatchSink, scope: Scope): Promise<void>;
  /**
   * 「root 下面可能变过」(窗口回到眼前、agent 停下、改动面板被打开…)。只有按目录兑现整棵树订阅的平台
   * (Linux inotify)会给落在 root 里的 coarse 整棵树订阅发 resync;一个根就能看整棵树的平台(FSEvents、
   * ReadDirectoryChangesW)本来就不缺事件,什么都不做。返回这一下有没有兑现(有按目录兑现的整棵树订阅落在 root 里):
   * 调用方据此决定要不要跟着做「没人盯着的地方可能变了」的那份重活(例如文件索引重扫)—— 平台差别不出 transport。
   */
  nudge?(root?: string): Promise<boolean> | boolean;
  dispose?(): Promise<void> | void;
}
