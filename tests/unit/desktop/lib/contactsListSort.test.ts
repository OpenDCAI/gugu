import { describe, expect, it } from 'vitest'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { contact } from '../../../support/testHarness'
import {
  getPinyinInitial,
  groupContacts,
  PINNED_CONTACTS_SECTION,
  sortContactsPinnedFirst,
  sortGroupChatsPinnedFirst,
} from '../../../../apps/desktop/src/lib/contactsListSort'
function groupChat(overrides: Partial<ContactGroupChat>): ContactGroupChat {
  return {
    id: 'group-1',
    kind: 'group',
    name: 'Group One',
    avatar_url: null,
    member_count: 3,
    is_muted: false,
    ...overrides,
  }
}
describe('通讯录字母索引按读音分段', () => {
  it('汉字名按拼音首字母归段(原先按码位切段:周→B、林→G、陈→X)', () => {
    const expected: Record<string, string> = {
      周一鸣: 'Z', 林夏: 'L', 陈嘉禾: 'C', 一个名字: 'Y', 阿成: 'A', 吕布: 'L', 马超: 'M', 欧阳: 'O', 钱多: 'Q',
    }
    for (const [name, letter] of Object.entries(expected)) expect(getPinyinInitial(name), name).toBe(letter)
  })
  it('拉丁字母照首字母,其余符号进 #', () => {
    expect(getPinyinInitial('momo')).toBe('M')
    expect(getPinyinInitial('7 号')).toBe('#')
    expect(getPinyinInitial('')).toBe('#')
  })
  it('同一段里汉字按读音排(陆在林后),拉丁名排在汉字之后', () => {
    const lin = contact({ id: 'lin', display_name: '林夏' })
    const lily = contact({ id: 'lily', display_name: 'Lily' })
    const lu = contact({ id: 'lu', display_name: '陆离' })
    expect(groupContacts([lu, lin, lily])).toEqual([{ letter: 'L', items: [lin, lu, lily] }])
  })
})
describe('contact list pinned sorting', () => {
  it('preserves letter grouping when no contacts are pinned', () => {
    const contacts = [
      contact({ id: 'bob', display_name: 'Bob' }),
      contact({ id: 'alice', display_name: 'Alice' }),
    ]
    expect(groupContacts(contacts)).toEqual([
      { letter: 'A', items: [contacts[1]] },
      { letter: 'B', items: [contacts[0]] },
    ])
  })
  it('isolates pinned contacts first and sorts the pinned section by display name', () => {
    const alice = contact({ id: 'alice', display_name: 'Alice' })
    const bob = contact({ id: 'bob', display_name: 'Bob' })
    const zoe = contact({ id: 'zoe', display_name: 'Zoe' })
    const pinned = new Set(['alice', 'zoe'])
    expect(groupContacts([zoe, bob, alice], (item) => pinned.has(item.id))).toEqual([
      { letter: PINNED_CONTACTS_SECTION, items: [alice, zoe] },
      { letter: 'B', items: [bob] },
    ])
  })
})
// #2598 桌面三分区侧栏是扁平列表(无字母分组),用这条链路把置顶前置。
describe('flat contact list pinned sorting (desktop sidebar)', () => {
  it('returns the original list when no contacts are pinned', () => {
    const contacts = [
      contact({ id: 'bob', display_name: 'Bob' }),
      contact({ id: 'alice', display_name: 'Alice' }),
    ]
    expect(sortContactsPinnedFirst(contacts)).toBe(contacts)
  })
  it('sorts pinned contacts by display name and keeps unpinned contacts stable', () => {
    const zoe = contact({ id: 'zoe', display_name: 'Zoe' })
    const bob = contact({ id: 'bob', display_name: 'Bob' })
    const alice = contact({ id: 'alice', display_name: 'Alice' })
    const pinned = new Set(['zoe', 'alice'])
    expect(sortContactsPinnedFirst([zoe, bob, alice], (item) => pinned.has(item.id)))
      .toEqual([alice, zoe, bob])
  })
  it('honors the contact alias as the pinned sort key', () => {
    const aliased = contact({ id: 'zeta', display_name: 'Zeta', alias: 'Aaron' })
    const bob = contact({ id: 'bob', display_name: 'Bob' })
    expect(sortContactsPinnedFirst([bob, aliased], () => true)).toEqual([aliased, bob])
  })
})
describe('group list pinned sorting', () => {
  it('returns the original list when no groups are pinned', () => {
    const groups = [groupChat({ id: 'alpha' }), groupChat({ id: 'beta' })]
    expect(sortGroupChatsPinnedFirst(groups)).toBe(groups)
  })
  it('sorts pinned groups by name and keeps unpinned groups stable', () => {
    const zoo = groupChat({ id: 'zoo', name: 'Zoo Team' })
    const beta = groupChat({ id: 'beta', name: 'Beta Team' })
    const alpha = groupChat({ id: 'alpha', name: 'Alpha Team' })
    const pinned = new Set(['zoo', 'alpha'])
    expect(sortGroupChatsPinnedFirst([zoo, beta, alpha], (group) => pinned.has(group.id)))
      .toEqual([alpha, zoo, beta])
  })
})
