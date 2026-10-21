/**
 * spec session-graph:一条会话的**子会话** = 挂在它下面的,按父会话这条边(侧栏建树用的同一个 `parentSessionId`)
 * 递归。派出去但没挂的不算(owner 10-08:挂在你下面的才给你干活,没挂的是给人用的)。
 *
 * ❌ fork 不在其中:`config.forkedFrom` 只是 provider transcript 血缘,fork 与它的来源在所有意义上都是
 * 平行的同级(owner 2026-09-11),❌ 不得再被当成产品层级。归档与删除共用这一处枚举 —— 抄第二份的那天,
 * 两个动词就开始对「谁是子会话」给出不同答案。
 *
 * #5665 一个任务 = 一个会话:spawn 出来的孩子各住一项 task。所以「名下有几条子会话」要喂**全部挂着的**
 * 会话(`sessionRegistry.allSessions`,派到别的机器上的也在里面),❌ 只喂一项 task 的表 —— 那张表里永远数不到孩子,
 * 确认框也就永远不给「连同子会话」那个选项。
 */
type DescendantEdges = {
  data: { parentSessionId?: string | null };
};

export function sessionDescendantIds(
  sessions: ReadonlyMap<string, DescendantEdges>,
  rootId: string
): string[] {
  const found = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [id, store] of sessions) {
      if (found.has(id) || id === rootId) continue;
      if (store.data.parentSessionId === current) {
        found.add(id);
        queue.push(id);
      }
    }
  }
  return [...found];
}

export function countSessionDescendants(
  sessions: ReadonlyMap<string, DescendantEdges>,
  rootId: string
): number {
  return sessionDescendantIds(sessions, rootId).length;
}
