import { observable, runInAction } from 'mobx';

/**
 * 「这张卡我不看了」——**只是不看,不是它跑完了**(owner 2026-09-06:「可以手动关掉也行
 * 悬浮出个 x 号,手动关这样子」)。
 *
 * # 为什么需要手动这一路
 *
 * 后台派出去的子智能体什么时候算完,不由我们定:claude 把「跑完了」写成一条
 * `<task-notification>` 用户消息注进会话,而那条消息**只在下一个回合到来时才送达**。
 * ⇒ 一轮结束后用户不再说话,卡就一直挂着;而一次失败后重派的那些,原来那张卡可能
 * 永远等不到任何人来报。攒几次就是 owner 说的「一堆的 agent,但实际只起了 3 个」。
 *
 * 试过并否掉的自动路子(细节见 `subagent-roster.ts` 顶上那段):提交这一轮时顺手写成完成
 * = 替它宣布一个没发生的结局;会话一闲就清空 = 把「我们不知道」和「它停了」混成一件事。
 * ⇒ 留给人来判断。**这个开关只改我们显示什么,一个字都不改它的状态** —— 面板上少一张卡,
 * 转录里那条 tool call 行照旧是它本来的样子。
 *
 * # 为什么不落盘
 *
 * 落盘等于把「我看过了,不用管它」记成一条关于那次运行的结论 —— 而我们恰恰**不知道**
 * 它的结局。⇒ 只活在这一次会话里:面板关掉、切走再回来都还在(所以不能放进组件的
 * state,弹层一关就卸载了),重启就重来。真要跨重启记住,那是 owner 另拍的一件事。
 */
const dismissed = observable.set<string>();

/** 键要带上会话:同一个转录条目 id 在不同会话里各是各的。 */
function keyOf(sessionId: string, entryId: string): string {
  return `${sessionId}::${sessionId}::${entryId}`;
}

export function dismissSubagent(sessionId: string, entryId: string): void {
  runInAction(() => {
    dismissed.add(keyOf(sessionId, entryId));
  });
}

export function isSubagentDismissed(
  sessionId: string,
  entryId: string
): boolean {
  return dismissed.has(keyOf(sessionId, entryId));
}

/** 只给测试用 —— 模块级状态在用例之间会串。 */
export function resetSubagentDismissals(): void {
  runInAction(() => {
    dismissed.clear();
  });
}
