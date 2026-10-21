import type { DependencyStatus, InstallationReading } from '@shared/core/agents/agent-payload';

/**
 * 一家 harness 在界面上的**那一种**状态(#6157)。
 *
 * spec(`task-renderer/harness-install-panel`)把它定死成五个:未安装 / 安装中 / 已安装 /
 * 有新版本 / 装了但起不来。图标网格把它画成图标上的样子(灰化、进度环、角标),面板把它写成
 * 顶上那一行字 —— **两处同一个函数**,❌ 别各自算一遍:owner 撞到的那一格正是列表挂着
 * 「有可用更新」、点进去一个更新入口都没有(#6101),因为那两处当时问的是两个不同的问题。
 */
export type HarnessState =
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'update-available'
  /** 文件在,`--version` 跑不出来。 */
  | 'broken';

export function resolveHarnessState(input: {
  /** 四态读数 —— 只有它分得出「文件在但跑不起来」。 */
  reading: InstallationReading;
  /**
   * 运行时真会跑的那一份的状态。它**已经**带着「选中那一份没了就回落自动解析」那一步
   * (`deriveHostDependencyStatus`),所以 `reading === 'missing'` 而机器上还有别的能跑的
   * 副本时,这里读到的是 `available` —— 用户面上就该是「已安装」,因为咕咕确实跑得起来。
   */
  status: DependencyStatus;
  /** 正在装或正在更新。 */
  busy: boolean;
  /**
   * 有新版本,而且咕咕**动得了**它。
   *
   * 不归咕咕管的那一份也算 —— 此时「更新」的含义是咕咕装一份最新的切过去(spec)。
   * 这一家咕咕根本装不了时必须是 false:❌ 不挂一枚点进去没有下一步的角标。
   */
  updateAvailable: boolean;
}): HarnessState {
  if (input.busy) return 'installing';
  // 排在可用性之前:文件就在盘上,说「未安装」会让用户去装第二份(#6101)。
  if (input.reading === 'detected-but-broken') return 'broken';
  if (input.status === 'available') {
    return input.updateAvailable ? 'update-available' : 'installed';
  }
  if (input.status === 'error') return 'broken';
  return 'not-installed';
}
