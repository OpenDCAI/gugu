// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { chat, displayIdentity } from '../../../support/testHarness'
import { createChatMembershipProjection, memoizeChatRow } from '../../../../apps/desktop/src/lib/chatRowDerivations'
import { publishChatSummaries, readChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'

afterEach(() => publishChatSummaries([]))

it.each([10, 100, 1000])('derives only the changed row among %i rows', size => {
  const rows = Array.from({ length: size }, (_, index) => chat({ id: `c${index}` }))
  const visits: string[] = []
  const derive = memoizeChatRow(row => { visits.push(row.id); return row.last_message_preview })
  rows.map(derive)
  visits.length = 0
  const changed = { ...rows[0]!, last_message_preview: 'new' }
  const actual = [changed, ...rows.slice(1)].map(derive)
  console.info('derived rows', visits)
  expect(visits).toEqual(['c0'])
  expect(actual[0]).toBe('new')
})

it('derives the same member signature for a preview change and updates membership/identity changes', () => {
  const project = createChatMembershipProjection()
  const directory = { agent: displayIdentity('agent', { type: 'agent' }), human: displayIdentity('human') }
  const original = chat({ id: 'group', kind: 'group', member_user_ids: ['human', 'agent'] })
  const before = project([original], directory)
  expect(project([{ ...original, last_message_preview: 'new' }], directory)).toBe(before)
  expect(project([{ ...original, member_user_ids: ['human'] }], directory).key).toBe('group:human')
  expect(project([original], { ...directory, human: displayIdentity('human', { type: 'agent' }) }).agentIds).toEqual(['agent', 'human'])
})

it('keeps aggregate agent ids and skips sort when a private preview changes or rows move', () => {
  const project = createChatMembershipProjection()
  const directory = { agent: displayIdentity('agent', { type: 'agent' }) }
  const dm = chat({ id: 'dm', kind: 'dm', peer_user_id: 'agent' })
  const group = chat({ id: 'group', kind: 'group', member_user_ids: ['agent'] })
  const before = project([dm, group], directory)
  const sort = vi.spyOn(Array.prototype, 'sort')
  try {
    const next = project([group, { ...dm, last_message_preview: 'new' }], directory)
    expect(sort).not.toHaveBeenCalled()
    expect(next).toBe(before)
    expect(next.agentIds).toBe(before.agentIds)
  } finally { sort.mockRestore() }
  expect(project([dm], directory).agentIds).toEqual(['agent'])
})

it.each([10, 100, 1000])('reads summary fields for only the changed row among %i rows', size => {
  const reads: string[] = []
  const row = (id: string, preview: string) => ({ ...chat({ id }), get last_message_preview() { reads.push(id); return preview } })
  const rows = Array.from({ length: size }, (_, index) => row(`c${index}`, 'old'))
  publishChatSummaries(rows)
  const previous = readChatSummaries()!
  reads.length = 0
  publishChatSummaries([row('c0', 'new'), ...rows.slice(1)])
  console.info('summary field reads', reads)
  expect(reads).toEqual(['c0'])
  expect(readChatSummaries()!.get('c0')!.lastMessagePreview).toBe('new')
  expect(readChatSummaries()!.get('c1')).toBe(previous.get('c1'))
})

it('removes optional address and alias fields and preserves an unchanged summary across a moved row', () => {
  const first = chat({ id: 'a', alias: 'alias', public_id: 1234 })
  const second = chat({ id: 'b' })
  publishChatSummaries([first, second])
  const held = readChatSummaries()!.get('b')
  publishChatSummaries([second, { ...first, alias: null, public_id: null }])
  expect(readChatSummaries()!.get('a')).not.toHaveProperty('alias')
  expect(readChatSummaries()!.get('a')).not.toHaveProperty('publicId')
  expect(readChatSummaries()!.get('b')).toBe(held)
})
