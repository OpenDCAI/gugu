import type { ChatItem } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { displayName } from './contactsListSort'
import { matchText, normalizeMentionKey } from './mentionMatch'

// 通讯录搜索:有关键词时,人 / Agent / 群三组各自排好序,桌面侧栏与手机首页的结果表共用。
// 字段:标题(备注优先的显示名 / 群名)、原名(设了备注时)、完整咕咕号 / 群号 —— 号码只认全等。
// 排序:档位(全等 > 前缀 > 包含 > 拼音)→ 标题命中先于原名 / 号码 → 最近聊过的在前 → 拼音序。

export type ContactSearchField = 'title' | 'original' | 'number'

export interface ContactSearchHit<T> {
  item: T
  field: ContactSearchField
  /** 命中那个字段的原文;hits 是命中字在它里面的下标。 */
  text: string
  hits: number[]
  score: number
}

export interface ContactSearchResult {
  people: ContactSearchHit<ContactUser>[]
  agents: ContactSearchHit<ContactUser>[]
  groups: ContactSearchHit<ContactGroupChat>[]
}

const FIELD_RANK: Record<ContactSearchField, number> = { title: 0, original: 1, number: 2 }
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin')

/** 字段按 标题 → 原名 → 号码 给出;同分取先出现的,所以标题命中不会被原名顶掉。 */
function bestHit<T>(item: T, fields: [ContactSearchField, string | null][], query: string, key: string): ContactSearchHit<T> | null {
  let best: ContactSearchHit<T> | null = null
  for (const [field, text] of fields) {
    if (!text) continue
    const match = field === 'number'
      ? (text === key ? { score: 4, hits: Array.from(text, (_, i) => i) } : null)
      : matchText(text, query)
    if (match && (!best || match.score > best.score)) best = { item, field, text, ...match }
  }
  return best
}

function ranked<T>(hits: ContactSearchHit<T>[], title: (item: T) => string, recentKey: (item: T) => string, recentAt: ReadonlyMap<string, number>) {
  const recent = (item: T) => recentAt.get(recentKey(item)) ?? 0
  return hits.sort((a, b) =>
    b.score - a.score
    || FIELD_RANK[a.field] - FIELD_RANK[b.field]
    || recent(b.item) - recent(a.item)
    || collator.compare(title(a.item), title(b.item)))
}

/** 私聊按对端、群按群 id 记最后一条消息的时刻;没发过消息的会话不算「聊过」。 */
export function recentChatActivity(chats: readonly Pick<ChatItem, 'id' | 'kind' | 'peer_user_id' | 'last_message_at'>[]): Map<string, number> {
  const at = new Map<string, number>()
  for (const chat of chats) {
    const key = chat.kind === 'dm' || chat.kind === 'ai' ? chat.peer_user_id : chat.id
    const time = chat.last_message_at ? Date.parse(chat.last_message_at) : NaN
    if (key && Number.isFinite(time)) at.set(key, Math.max(time, at.get(key) ?? 0))
  }
  return at
}

/** 空关键词返回 null(调用方显示浏览视图)。 */
export function searchContacts(
  query: string,
  { people, agents, groups, recentAt }: { people: ContactUser[]; agents: ContactUser[]; groups: ContactGroupChat[]; recentAt: ReadonlyMap<string, number> },
): ContactSearchResult | null {
  const key = normalizeMentionKey(query)
  if (!key) return null
  const contactHits = (list: ContactUser[]) => ranked(list.flatMap((contact) => {
    const title = displayName(contact)
    const hit = bestHit(contact, [
      ['title', title],
      ['original', title === contact.display_name ? null : contact.display_name],
      ['number', contact.gugu_number == null ? null : String(contact.gugu_number)],
    ], query, key)
    return hit ? [hit] : []
  }), displayName, (contact) => contact.id, recentAt)
  const groupHits = ranked(groups.flatMap((group) => {
    const hit = bestHit(group, [['title', group.name], ['number', group.public_id == null ? null : String(group.public_id)]], query, key)
    return hit ? [hit] : []
  }), (group) => group.name, (group) => group.id, recentAt)
  return { people: contactHits(people), agents: contactHits(agents), groups: groupHits }
}
