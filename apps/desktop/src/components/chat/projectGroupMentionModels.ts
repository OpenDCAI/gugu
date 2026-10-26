/**
 * 项目群主线上能点名谁(owner 10-26,OpenDCAI/gugu#446):任务 agent 不在群聊说话、群里 @ 不到它 —— 它的活在任务卡开出的
 * 话题里,在那儿照旧点得到。项目群里的 agent 都是任务 agent,所以主线也不给「@所有人」(那会把它们一起叫醒)。
 * 名册同时喂候选、打字的 @ 和开头呼语,三条路一起收窄,❌ 只藏候选、打出来的名字照样叫醒人。
 * `taskAgentIds` = null:不是项目群的主线(普通群、话题、还不知道是不是项目群),名册原样。
 */
export function projectGroupMainLine<T extends { id: string }>(
  roster: T[],
  taskAgentIds: readonly string[] | null,
): { roster: T[]; mentionAll: boolean; reachable: (id: string) => boolean } {
  if (!taskAgentIds) return { roster, mentionAll: true, reachable: () => true }
  const hidden = new Set(taskAgentIds)
  return { roster: roster.filter((member) => !hidden.has(member.id)), mentionAll: false, reachable: (id) => !hidden.has(id) }
}
