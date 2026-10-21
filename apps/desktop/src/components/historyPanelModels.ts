// @@@5856 历史面板的纯判据。单独一个文件是 react-refresh 的要求(HistoryPanel.tsx 只导出组件),
// 也让「默认落在哪个 tab」这条能被单独判真假 —— 它出过一次回归。

export type HistoryPanelMode = 'group' | 'private' | 'topic'
export type HistoryTab = 'topics' | 'imported' | 'attachments'

/**
 * 打开历史面板时默认停在哪个 tab。按「打开它通常是为了什么」定,❌ 不是「哪个 tab 排第一」:
 * - 群 → 话题。群是话题长出来的地方,列表通常非空。
 * - 私聊 → 导入历史。绝大多数私聊一条话题都没有,落在空态上等于让人再点一下。
 * - 话题自己 → 只有附件这一个 tab。
 *
 * ⚠️ 给私聊**加**话题 tab 的时候这三支曾被折成一句,顺手把 private 的落点也改掉了。
 * 加 tab 不等于改默认落点。
 */
export function defaultHistoryTab(mode: HistoryPanelMode): HistoryTab {
  if (mode === 'topic') return 'attachments'
  if (mode === 'private') return 'imported'
  return 'topics'
}

/**
 * 话题 tab 一次画多少张卡。这里是一条线**全部**话题的主场(会话列表只摊开最近几条,
 * 其余那一行点进来就落在这儿),所以一个老群进来就是两百条 —— 一次全画会把面板撑坏
 * (owner 2026-09-20:「一展开就会让整个界面崩坏掉」)。往下滚自动接下一页,
 * ❌ 不做「加载更多」按钮。
 */
export const HISTORY_TOPIC_PAGE = 30

/** 按标题过滤。两百条里找某一条靠搜名字,❌ 不靠滚。空查询=不过滤。 */
export function filterTopicsByQuery<T extends { title: string }>(topics: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...topics]
  return topics.filter((topic) => topic.title.toLowerCase().includes(needle))
}

/** 画出来的那一页 + 还剩多少。页数从 1 起步:展开永远看得见东西。 */
export function pageHistoryTopics<T>(
  topics: readonly T[],
  pages: number,
  pageSize: number = HISTORY_TOPIC_PAGE,
): { shown: T[]; remaining: number } {
  const shown = topics.slice(0, Math.max(1, Math.floor(pages)) * pageSize)
  return { shown, remaining: topics.length - shown.length }
}
