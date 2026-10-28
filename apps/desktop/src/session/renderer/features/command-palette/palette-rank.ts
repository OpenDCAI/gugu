import { matchText, normalizeMentionKey } from '@/lib/mentionMatch';

// ⌘O 快速切换与 @ 选人同一套匹配(owner 10-28「quick switcher 没用上任何排序」):全等 > 前缀 > 包含 > 拼音,
// NFKC 折叠、去空白标点。同分保持来源顺序 —— 对话列表本来就按最近活动排,任务来自 bm25 / 最近交互。
// recallOnly: 来源已经做过召回(本机索引还按分支名、issue 匹配),只排序、不再过滤。
export function rankPaletteMatches<T>(items: readonly T[], query: string, texts: (item: T) => readonly (string | null | undefined)[], { recallOnly = false } = {}): T[] {
  if (!normalizeMentionKey(query)) return [...items];
  return items
    .map((item, index) => ({ item, index, score: Math.max(0, ...texts(item).map((text) => matchText(text, query)?.score ?? 0)) }))
    .filter((row) => recallOnly || row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item);
}
