import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { appState } from '@renderer/lib/stores/app-state';

/**
 * 一个项目在这台桌面眼里在不在 —— 与主进程恢复导航时的判断(core/view-state `restoredSessionState`)同一条规矩:
 * 只有「确知已删除」才算没了,❌ 「此刻不在表里 = 被删了」。
 *  · present:项目表里有(本机的,或某台机器连上读到的清单 / 账号上记着的那份并进来的)。
 *  · unknown:不在表里,而别的机器的清单这一端还没齐 —— 开机恢复上次视图那一刻总是这样(会话页还没起、名册还没接上)。
 *    名册接上、账号上那份并进来、连上读到清单,都会重跑守卫(remote-hosts-store),那时还没有,才是 deleted。
 *  · deleted:其余。本机项目开机就整张读进来;别的机器的清单到了也没有它。
 */
export type ProjectPresence = 'present' | 'unknown' | 'deleted';

export function projectPresence(projectId: string): ProjectPresence {
  if (appState.projects.projects.has(projectId) || appState.projects.pendingCreationIds.has(projectId)) return 'present';
  return remoteHostsStore.awaitsMachineLists() ? 'unknown' : 'deleted';
}
