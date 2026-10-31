import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'

export const PINNED_CONTACTS_SECTION = '__pinned__'

export function displayName(contact: ContactUser): string {
  return contact.alias?.trim() || contact.display_name
}

// 拼音首字母:ICU 拼音排序,拿每段首字当分界(阿→A、八→B…)。❌ 按码位切段(码位按部首排,周→B 林→G 陈→X)。
const PINYIN_LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const PINYIN_BOUNDARIES = '阿八嚓哒妸发旮哈讥咔垃妈拿噢妑七呥仨他屲夕丫帀'
const pinyinCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin')

export function getPinyinInitial(name: string): string {
  if (!name) return '#'
  const ch = name.charAt(0)
  if (/[A-Za-z]/.test(ch)) return ch.toUpperCase()
  if (!/\p{Script=Han}/u.test(ch)) return '#'
  for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i -= 1) {
    if (pinyinCollator.compare(ch, PINYIN_BOUNDARIES[i]) >= 0) return PINYIN_LETTERS[i]
  }
  return '#'
}

/** 同一段里按读音排(「陈」在「程」前),与字母索引用同一把尺。 */
const byName = (a: ContactUser, b: ContactUser) => pinyinCollator.compare(displayName(a), displayName(b))

export function groupContacts(
  contacts: ContactUser[],
  isPinned: (contact: ContactUser) => boolean = () => false,
): { letter: string; items: ContactUser[] }[] {
  const pinned: ContactUser[] = []
  const unpinned: ContactUser[] = []
  for (const contact of contacts) {
    (isPinned(contact) ? pinned : unpinned).push(contact)
  }
  pinned.sort(byName)

  const map = new Map<string, ContactUser[]>()
  for (const contact of unpinned) {
    const letter = getPinyinInitial(displayName(contact))
    const group = map.get(letter) ?? []
    group.push(contact)
    map.set(letter, group)
  }

  const lettered = [...map.entries()]
    .sort(([a], [b]) => {
      if (a === '#') return 1
      if (b === '#') return -1
      return a.localeCompare(b)
    })
    .map(([letter, items]) => ({
      letter,
      items: items.sort(byName),
    }))

  return pinned.length > 0
    ? [{ letter: PINNED_CONTACTS_SECTION, items: pinned }, ...lettered]
    : lettered
}

// #2598 扁平列表的置顶前置(桌面三分区侧栏用):置顶项排最前、内部按名字序,非置顶保持原有相对
// 顺序 —— 取消置顶即回到原位置。无置顶时原样返回入参引用,不做无意义拷贝。
function pinnedFirst<T>(items: T[], isPinned: (item: T) => boolean, label: (item: T) => string): T[] {
  const pinned: T[] = []
  const unpinned: T[] = []
  for (const item of items) {
    (isPinned(item) ? pinned : unpinned).push(item)
  }
  if (pinned.length === 0) return items
  pinned.sort((a, b) => label(a).localeCompare(label(b)))
  return [...pinned, ...unpinned]
}

export function sortContactsPinnedFirst(
  contacts: ContactUser[],
  isPinned: (contact: ContactUser) => boolean = () => false,
): ContactUser[] {
  return pinnedFirst(contacts, isPinned, displayName)
}

export function sortGroupChatsPinnedFirst(
  groups: ContactGroupChat[],
  isPinned: (group: ContactGroupChat) => boolean = () => false,
): ContactGroupChat[] {
  return pinnedFirst(groups, isPinned, groupDisplayName)
}

export function userPublicId(contact: Pick<ContactUser, 'gugu_number'>): string | null {
  return contact.gugu_number == null ? null : String(contact.gugu_number)
}

export function chatPublicId(chat: Pick<ContactGroupChat, 'public_id'>): string | null {
  return chat.public_id == null ? null : String(chat.public_id)
}
