// 拼在一屏的几块是一组(spec session-page「拼在一屏的几块是一组」):侧栏每个列表把同一组的几行并在一处。
// 会话页画的「项目」「置顶」(session/renderer/features/sidebar/sidebar-store.ts)和壳画的「对话」(components/ChatListPanel.tsx)
// 用这同一份:组员的键、框放在哪一行、行上记的那一段。两棵树都只 import 这一个文件,❌ 各写一份。

/** 一块装的那样东西的键(screen-layout 的 contentKey 就是它):两棵树按同一个键认出列表里的一行是组里的哪一块。 */
export const blockKey = {
  session: (sessionId: string) => `session:${sessionId}`,
  chat: (chatId: string) => `chat:${chatId}`,
  app: (tabKind: string) => `app:${tabKind}`,
  project: (projectId: string) => `project:${projectId}`,
}

/** 一组:组员按屏上从左上到右下(blockKey);`anchor` = 拼成一组之前正看着的那块;`onScreen` = 这组此刻在屏上。 */
export type JoinedGroup = { readonly members: readonly string[]; readonly anchor: string; readonly onScreen: boolean }

/** 这一行是框的哪一段(上沿 / 中间 / 下沿),框此刻在不在屏上(在 = 浅灰底,不在 = 一道细框)。 */
export type SidebarJoin = { pos: 'first' | 'middle' | 'last'; onScreen: boolean }

/**
 * 一组在一个列表里的那几行并到哪一行的位置 —— 只在这一处定。`listed` = 这个列表里有的组员,按组内次序。
 * 照 spec(owner 2026-10-10 认过):拼之前正看着的那一块在这个列表里 → 它那一行;不在 → 这个列表里组内第一条。
 */
export function joinedSlot(group: JoinedGroup, listed: readonly string[]): string {
  return listed.includes(group.anchor) ? group.anchor : listed[0]
}

/**
 * 一条平铺的列表(「对话」:对话和没有项目的会话按最近活动排):同一组在这里有两行以上 → 并在 joinedSlot 那一行的位置,
 * 组内照屏上次序,每一行带上它是框的哪一段;只有一行的组照常待在原处。
 */
export function joinRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  groups: readonly JoinedGroup[]
): Array<{ row: T; join?: SidebarJoin }> {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]))
  const boxes = new Map<string, { members: string[]; onScreen: boolean }>()
  const away = new Set<string>()
  for (const group of groups) {
    const listed = group.members.filter((key) => byKey.has(key))
    if (listed.length < 2) continue
    const slot = joinedSlot(group, listed)
    boxes.set(slot, { members: listed, onScreen: group.onScreen })
    for (const key of listed) if (key !== slot) away.add(key)
  }
  return rows.flatMap((row): Array<{ row: T; join?: SidebarJoin }> => {
    const key = keyOf(row)
    const box = boxes.get(key)
    if (!box) return away.has(key) ? [] : [{ row }]
    return box.members.map((member, i): { row: T; join: SidebarJoin } => ({
      row: byKey.get(member)!,
      join: { pos: i === 0 ? 'first' : i === box.members.length - 1 ? 'last' : 'middle', onScreen: box.onScreen },
    }))
  })
}
