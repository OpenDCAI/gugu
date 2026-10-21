import type { HostDependencyManager } from './host-dependency-manager';
import type { DependencyState, HostDependency } from './types';

/**
 * 下一次带着 `hostDependency` 的 onStatusUpdated —— 副本列表建完、存下、广播出去的那一刻。
 *
 * agent 类依赖的「列副本 → 存 → 发事件」在后台跑(probe 先返回,见 `buildHostDependencyAfterProbe`),
 * 用例要读副本列表 / 读数日志 / 账本,等的就是这一条事件,❌ 睡 50ms 再去读。
 * 在触发探测**之前**调用:先订阅,后触发。
 */
export function nextHostDependency(manager: HostDependencyManager, id: string): Promise<HostDependency> {
  return new Promise((resolve) => {
    const unsubscribe = manager.onStatusUpdated.subscribe((event) => {
      if (event.id !== id || !event.hostDependency) return;
      unsubscribe();
      resolve(event.hostDependency);
    });
  });
}

/** 探测一次,并等它在后台把副本列表建完。 */
export async function probeAndSettle(manager: HostDependencyManager, id: string): Promise<DependencyState> {
  const built = nextHostDependency(manager, id);
  const state = await manager.probe(id);
  await built;
  return state;
}
