import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * 一个项目在这台桌面眼里在不在 —— 与主进程恢复导航时的判断(core/view-state `restoredSessionState`)同一条规矩:
 * 只有「确知已删除」才算没了,❌ 「此刻不在表里 = 被删了」。
 *  · present:项目表里有(本机的,或某台机器的清单 / 上次记下的清单并进来的)。
 *  · unknown:不在表里,但它是别的机器上的、那台此刻的清单还没到 —— 开机恢复那一刻总是这样。那台的清单一到就
 *    重跑守卫(remote-hosts-store `syncProjects`),那时还没有,才是 deleted。
 *  · deleted:其余。本机项目开机就整张读进来;别的机器的清单到了也没有它。
 */
export type ProjectPresence = 'present' | 'unknown' | 'deleted';

export function projectPresence(projectId: string): ProjectPresence {
  if (appState.projects.projects.has(projectId) || appState.projects.pendingCreationIds.has(projectId)) return 'present';
  return remoteHostsStore.awaitsMachineList(projectId) ? 'unknown' : 'deleted';
}
