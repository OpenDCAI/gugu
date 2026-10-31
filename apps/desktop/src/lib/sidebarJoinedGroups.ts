// 拼在一屏的几块是一组(spec session-page「拼在一屏的几块是一组」):侧栏每个列表把同一组的几行并在一处 ——
// 并在这组在这个列表里最靠前那一行的位置(组里谁排到前面,整组跟着它;行只会往上挪,不会往下掉)。
// 会话页画的「项目」「置顶」(session/renderer/features/sidebar/sidebar-store.ts)和壳画的「对话」(components/ChatListPanel.tsx)
// 用这同一份:组员的键、组的形状、行上记的那一段。两棵树都只 import 这一个文件,❌ 各写一份。

/** 一块装的那样东西的键(screen-layout 的 contentKey 就是它):两棵树按同一个键认出列表里的一行是组里的哪一块。 */
export const blockKey = {
  session: (sessionId: string) => `session:${sessionId}`,
  chat: (chatId: string) => `chat:${chatId}`,
  app: (tabKind: string) => `app:${tabKind}`,
  project: (projectId: string) => `project:${projectId}`,
  /** 一个群里的一张 App 页单独占一块(那个群的那张;为某个文件开的认那个文件)。 */
  chatApp: (chatId: string, tabKind: string, itemId?: string) => `chat-app:${chatId}:${tabKind}:${itemId ?? ''}`,
  /** 示例项目(#709)只有一份。 */
  sampleProject: () => 'sample-project',
}

/** 一组:组员按屏上从左上到右下(blockKey);`onScreen` = 这组此刻在屏上。 */
export type JoinedGroup = { readonly members: readonly string[]; readonly onScreen: boolean }

/** 这一行是框的哪一段(上沿 / 中间 / 下沿),框此刻在不在屏上(在 = 浅灰底,不在 = 一道细框)。 */
export type SidebarJoin = { pos: 'first' | 'middle' | 'last'; onScreen: boolean }

/**
 * 一条平铺的列表(「对话」:对话和没有项目的会话按最近活动排):同一组在这里有两行以上 → 并在其中最靠前那一行的位置
 * (组里谁来了新消息排到最前,整组跟着上去),组内照屏上次序,每一行带上它是框的哪一段;只有一行的组照常待在原处。
 */
export function joinRows<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  groups: readonly JoinedGroup[]
): Array<{ row: T; join?: SidebarJoin }> {
  const byKey = new Map(rows.map((row) => [keyOf(row), row]))
  const boxOf = new Map<string, { members: string[]; onScreen: boolean }>()
  for (const group of groups) {
    const listed = group.members.filter((key) => byKey.has(key))
    if (listed.length < 2) continue
    const box = { members: listed, onScreen: group.onScreen }
    for (const key of listed) boxOf.set(key, box)
  }
  const placed = new Set<object>()
  return rows.flatMap((row): Array<{ row: T; join?: SidebarJoin }> => {
    const box = boxOf.get(keyOf(row))
    if (!box) return [{ row }]
    if (placed.has(box)) return []
    placed.add(box)
    return box.members.map((member, i): { row: T; join: SidebarJoin } => ({
      row: byKey.get(member)!,
      join: { pos: i === 0 ? 'first' : i === box.members.length - 1 ? 'last' : 'middle', onScreen: box.onScreen },
    }))
  })
}
