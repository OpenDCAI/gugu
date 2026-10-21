/**
 * 会话没能启动,因为本机这一家 harness 的版本低于**这一版客户端**要求的下界(#6341)。
 *
 * 下界写在客户端(`runtimeCompatibility.supportedFloor`),不从服务端下发:它是这一版代码用到的
 * harness 协议决定的,新旧客户端要的下界本来就不同。
 *
 * 出口是这一家**正式的安装与更新面板**(设置 → 智能体 → 它,`AgentDetailModal`):装咕咕托管的一份、
 * 换用本机另一份、手动指定,都在那里,进度也在那里 —— ❌ 不在失败页另写一套安装流程。
 */
export interface RuntimeUpgradeRequirement {
  providerId: string;
  installedVersion: string;
  supportedFloor: string;
  /** 被探到这个版本的那一份可执行文件。 */
  executable: string | null;
}
