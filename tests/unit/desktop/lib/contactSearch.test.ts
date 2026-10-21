import { describe, expect, it } from 'vitest'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { recentChatActivity, searchContacts } from '../../../../apps/desktop/src/lib/contactSearch'

const person = (id: string, display_name: string, extra: Partial<ContactUser> = {}): ContactUser =>
  ({ id, display_name, avatar: null, bio: null, type: 'human', ...extra })
const group = (id: string, name: string, public_id: number): ContactGroupChat =>
  ({ id, name, public_id, kind: 'group', avatar_url: null, member_count: 3, is_muted: false })

// 与 mac1 实测造的数据同形:同名、备注≠原名、多音字、号码里带 2 的人和群。
const people = [
  person('zs', '张三', { gugu_number: 109591 }),
  person('ls', '李四', { alias: '老李', gugu_number: 109592 }),
  person('wxm', '王小明', { gugu_number: 109593 }),
  person('cA', '陈晨', { gugu_number: 109594 }),
  person('cB', '陈晨', { gugu_number: 109595 }),
  person('al', 'Alice Wang', { gugu_number: 109596 }),
  person('zx', '曾小贤', { gugu_number: 109598 }),
  person('kv', 'Kevin', { alias: '凯文(产品)', gugu_number: 109599 }),
  person('sh', '单田芳', { gugu_number: 109600 }),
]
const agents = [person('c2', 'Claude 2', { type: 'agent' }), person('pico', 'Pico', { type: 'agent' })]
const groups = [group('g1', '产品周会', 208861), group('g2', '周末羽毛球', 208864), group('g3', 'Gugu Dev 讨论组', 208863)]
const run = (query: string, recentAt: ReadonlyMap<string, number> = new Map()) =>
  searchContacts(query, { people, agents, groups, recentAt })
const ids = (query: string, recentAt?: ReadonlyMap<string, number>) => {
  const result = run(query, recentAt)
  return result && { people: result.people.map((h) => h.item.id), agents: result.agents.map((h) => h.item.id), groups: result.groups.map((h) => h.item.id) }
}

describe('contact search', () => {
  it('returns null for an empty or punctuation-only query (the browse view stays)', () => {
    expect(run('')).toBeNull()
    expect(run('  ')).toBeNull()
  })

  it('matches Chinese names by pinyin initials, full spelling, mid-name start and either reading of a polyphone', () => {
    expect(ids('zs')?.people).toEqual(['zs'])
    expect(ids('zhangsan')?.people).toEqual(['zs'])
    expect(ids('xm')?.people).toEqual(['wxm'])
    expect(ids('zxx')?.people).toEqual(['zx'])
    expect(ids('cxx')?.people).toEqual(['zx'])
    expect(ids('shan')?.people).toEqual(['sh'])
    expect(ids('dan')?.people).toEqual(['sh'])
    expect(ids('zm')?.groups).toEqual(['g2'])
  })

  it('finds a contact with a remark by their original name and says so', () => {
    const [hit] = run('李四')!.people
    expect(hit.item.id).toBe('ls')
    expect(hit).toMatchObject({ field: 'original', text: '李四', hits: [0, 1] })
    expect(run('kevin')!.people[0]).toMatchObject({ field: 'original', text: 'Kevin' })
    expect(run('老李')!.people[0]).toMatchObject({ field: 'title', text: '老李' })
  })

  it('matches 咕咕号 / 群号 only as a whole number', () => {
    expect(run('109592')!.people[0]).toMatchObject({ field: 'number', text: '109592', hits: [0, 1, 2, 3, 4, 5] })
    expect(run('208861')!.groups[0]).toMatchObject({ field: 'number', text: '208861' })
    expect(ids('1095')).toEqual({ people: [], agents: [], groups: [] })
    // 「2」只中名字里有 2 的 Claude 2,不再中号码里带 2 的人和群
    expect(ids('2')).toEqual({ people: [], agents: ['c2'], groups: [] })
  })

  it('ignores spaces, punctuation and case', () => {
    expect(ids('Claude2')?.agents).toEqual(['c2'])
    expect(ids('claude 2')?.agents).toEqual(['c2'])
    expect(ids('PICO')?.agents).toEqual(['pico'])
  })

  it('ranks exact > prefix > contains > pinyin, then title before original name', () => {
    const lily = person('lily', 'Lily')
    const li = person('li', 'li')
    const result = searchContacts('li', { people: [...people, lily, li], agents: [], groups: [], recentAt: new Map() })!
    expect(result.people.map((h) => [h.item.id, h.score])).toEqual([
      ['li', 4], ['lily', 3], ['al', 2], ['ls', 1],
    ])
    // 老李:标题「老李」拼音命中,原名「李四」也拼音命中 → 同分取标题
    expect(result.people.at(-1)).toMatchObject({ field: 'title', hits: [1] })
  })

  it('puts the recently chatted one first within a tier, then pinyin order', () => {
    expect(ids('陈晨')?.people).toEqual(['cA', 'cB'])
    expect(ids('陈晨', new Map([['cB', 2_000], ['cA', 1_000]]))?.people).toEqual(['cB', 'cA'])
    expect(ids('zhou')?.groups).toEqual(['g1', 'g2'])
    expect(ids('zhou', new Map([['g2', 1]]))?.groups).toEqual(['g2', 'g1'])
  })

  it('gives highlight indices into the shown text', () => {
    expect(run('wang')!.people.map((h) => [h.item.id, h.hits])).toEqual([['al', [6, 7, 8, 9]], ['wxm', [0]]])
    expect(run('讨论')!.groups[0]).toMatchObject({ field: 'title', hits: [9, 10] })
  })
})

describe('recent chat activity', () => {
  it('keys DMs by the peer and rooms by chat id; chats without a message do not count', () => {
    const at = recentChatActivity([
      { id: 'dm-1', kind: 'dm', peer_user_id: 'zs', last_message_at: '2026-09-29T08:00:00Z' },
      { id: 'ai-1', kind: 'ai', peer_user_id: 'pico', last_message_at: '2026-09-29T09:00:00Z' },
      { id: 'g1', kind: 'group', peer_user_id: null, last_message_at: '2026-09-29T07:00:00Z' },
      { id: 'dm-2', kind: 'dm', peer_user_id: 'wxm', last_message_at: null },
    ])
    expect([...at.keys()].sort()).toEqual(['g1', 'pico', 'zs'])
    expect(at.get('pico')).toBe(Date.parse('2026-09-29T09:00:00Z'))
  })
})
