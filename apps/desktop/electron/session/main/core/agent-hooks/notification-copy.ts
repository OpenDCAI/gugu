/**
 * @@@5301 会话页 agent 系统通知的正文,由宿主注入。
 *
 * 为什么是注入而不是 import 宿主的语言 store:会话页是内聚模块(owner #43),跨界一律走注入。
 * 而且那个 store **有模块级状态** —— 会话页这侧 import 它只会拿到一份复制品,宿主赋的值
 * 永远看不见,于是所有人都收到兜底语言,而且不报错。
 *
 * 宿主在启动时注入一次、语言切换时再注入。没注入就是接线错了 ⇒ 抛(由通知那层记下),❌ 退回一份英文原文
 * 装作一切正常 —— 那正是中文用户收到英文横幅、日志里却一个字都没有的形状。
 */
export type SessionAgentNotificationCopy = {
  needsApproval: string;
  /** 停在问题 / 计划上等人回答(#6448:needs_user 的 question / plan 附属态)。 */
  needsAnswer: string;
};

let injected: SessionAgentNotificationCopy | null = null;

export function setSessionAgentNotificationCopy(next: SessionAgentNotificationCopy): void {
  injected = next;
}

export function sessionAgentNotificationCopy(): SessionAgentNotificationCopy {
  if (!injected) throw new Error('session agent notification copy was never injected by the host');
  return injected;
}
