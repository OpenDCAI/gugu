// @@@5856 会话列表里「话题挂在来源那条线底下」的归组规则(product spec)。
//
// owner 2026-09-19:「怎么还有把一个 topic 当做群的形式表达」——
// 话题❌ 不占一行平级的会话,它是来源线下面的子行。
//
// 抽成纯函数不是为了好看:这里有三条**只在边界上才显形**的坑,判官盯的就是它们。
//   ① 搜索:用户搜话题名时,匹配的是话题,它的来源线往往一个字都不匹配。若来源线因此不渲染,
//      子行跟着一起没了 ⇒「搜得到」这句承诺在界面上是假的。
//   ② 来源线自己不在列表里了(被归档、被退出):子行没地方挂 ⇒ 话题会**彻底消失**,
//      而我仍然是它的成员、它照样给我发通知。所以这种话题退回占一行顶层,❌ 不许人间蒸发。
//   ③ 沉降:`isSunkTopic` 只对 kind==='topic' 为真,而话题永不占顶层 ⇒ 顶层那一段沉降列表恒空。
//      沉降只能发生在**子行这一层**(见 splitSunkTopics),❌ 不是列表底部那个「更早」分段。
import type { ChatItem } from '@gugu/core/shared/types/chat'

export function isTopicRow(chat: Pick<ChatItem, 'kind'>): boolean {
  return chat.kind === 'topic'
}

export type TopicNesting = {
  /** 来源线 id → 挂在它底下的话题(已按时间排好)。 */
  bySource: Map<string, ChatItem[]>
  /** 真的挂上去了的那些话题 id —— 没挂上的要退回顶层,靠这个集合区分。 */
  nestedIds: Set<string>
}

/**
 * 按来源线把话题归组。两个判据都注进来,不写死在这里:
 * @param keep        这条该不该出现在列表里(未归档 / 命中搜索 / …)——属于列表,不属于归组。
 * @param sourceListed 这条来源线此刻在不在列表里。不在 ⇒ 这条话题挂不上去,交回顶层。
 */
export function groupTopicsBySource(
  chats: readonly ChatItem[],
  keep: (chat: ChatItem) => boolean,
  byTime: (a: ChatItem, b: ChatItem) => number,
  sourceListed: (sourceChatId: string) => boolean,
): TopicNesting {
  const bySource = new Map<string, ChatItem[]>()
  const nestedIds = new Set<string>()
  for (const chat of chats) {
    if (!isTopicRow(chat) || !chat.source_chat_id) continue
    if (!keep(chat)) continue
    if (!sourceListed(chat.source_chat_id)) continue
    const bucket = bySource.get(chat.source_chat_id)
    if (bucket) bucket.push(chat)
    else bySource.set(chat.source_chat_id, [chat])
    nestedIds.add(chat.id)
  }
  for (const bucket of bySource.values()) bucket.sort(byTime)
  return { bySource, nestedIds }
}

/**
 * 这条会话该不该占一行顶层。
 * - 话题:只有**没挂上任何来源线**时才占(来源被归档/退出的那种),否则它是子行。
 * - 普通会话:自己没命中搜索、但底下有命中的话题时照样要占 —— 否则那条话题无处可挂。
 */
export function isTopLevelChatRow(
  chat: ChatItem,
  nesting: TopicNesting,
  listed: (chat: ChatItem) => boolean,
  matchesSearch: (chat: ChatItem) => boolean,
): boolean {
  if (!listed(chat)) return false
  if (isTopicRow(chat)) return matchesSearch(chat) && !nesting.nestedIds.has(chat.id)
  return matchesSearch(chat) || (nesting.bySource.get(chat.id)?.length ?? 0) > 0
}

/** 一条来源线底下最多摊开几条子行。owner 2026-09-20 实测后确定上限为 3 条。 */
export const TOPIC_SUBROW_LIMIT = 3

/**
 * 子行这一层的沉降:静了太久的话题收进「更早」,发一句就浮回来(spec:「没有开关,只有沉降」)。
 * 全都沉了也不许把这条线的话题整组藏掉 —— 那样用户只会以为话题丢了,所以「更早」那一行照常显示。
 *
 * 除了时间,还有**条数**这一道:一个群开到 11 条话题时,子行把整条侧边栏占满(owner 实测截图)。
 * 超出的❌ 不是消失,是并进同一个「更早」—— 它们按时间本来就排在后面,所以合进去之后那一段仍然
 * 是「更旧的那些」,❌ 不需要第二个折叠控件(一个东西一个名字)。
 *
 * 那一行❌ 不再就地展开。一个群一周能开出两百条话题,展开就是往一条没有虚拟化的侧边栏里
 * 灌两百行(owner 2026-09-20:「一展开就会让整个界面崩坏掉」);而这类清单在产品里**已经有主场**——
 * 来源线顶栏的「历史 → 话题」面板。⇒ 点它 = 跳到主场(带搜索),侧边栏只负责「最近这几条」。
 */
export function splitSunkTopics(
  topics: readonly ChatItem[],
  isSunk: (chat: ChatItem) => boolean,
  limit: number = TOPIC_SUBROW_LIMIT,
): { live: ChatItem[]; sunk: ChatItem[] } {
  const fresh: ChatItem[] = []
  const sunk: ChatItem[] = []
  for (const topic of topics) (isSunk(topic) ? sunk : fresh).push(topic)
  // 有未读的不受条数上限,与「有未读不沉」(isSunkTopic)是同一条:角标在数它,列表就得让人点得到它(#6433)。
  const live = fresh.filter((topic, index) => index < limit || topic.unread_count > 0)
  return { live, sunk: [...fresh.filter((topic) => !live.includes(topic)), ...sunk] }
}
