import { expect, it } from 'vitest'
import { message } from '../../../support/testHarness'
import { visibleReplyQuoteIds } from '../../../../apps/desktop/src/components/chat/replyQuoteVisibility'

const row = (id: string, sender: string | null, reply: string | null = null) => message({ id, sender_user_id: sender, reply_to_message_id: reply })
it('only omits the persistent mark for the exact message directly above', () => {
  expect([...visibleReplyQuoteIds([row('old', 'owner'), row('new', 'owner'), row('answer', 'agent', 'old')])]).toEqual(['answer'])
  expect([...visibleReplyQuoteIds([row('old', 'owner'), row('new', 'owner'), row('answer', 'agent', 'new')])]).toEqual([])
})
it('keeps marks for consecutive replies to an older message', () => {
  const rows = [row('old', 'owner'), row('new', 'owner'), row('a', 'agent', 'old'), row('b', 'agent', 'old'), row('c', 'agent'), row('d', 'agent', 'old')]
  expect([...visibleReplyQuoteIds(rows)]).toEqual(['a', 'b', 'd'])
})
it('compares explicit message IDs even for the same sender or unknown author', () => {
  expect([...visibleReplyQuoteIds([row('a', 'agent'), row('b', 'agent', 'a')])]).toEqual([])
  expect([...visibleReplyQuoteIds([row('question', 'owner'), row('answer', null, 'question'), row('again', null, 'question')])]).toEqual(['again'])
})
it('does not hide a history target that is not loaded', () => {
  expect([...visibleReplyQuoteIds([row('answer', 'agent', 'not-loaded')])]).toEqual(['answer'])
})
it('counts system and retracted rows between a quote and its target', () => {
  const system = { ...row('system', 'owner'), content_type: 'system' as const }
  const removed = { ...row('removed', 'owner'), retracted_at: '2026-10-27' }
  expect([...visibleReplyQuoteIds([row('question', 'owner'), system, removed, row('answer', 'agent', 'question')])]).toEqual(['answer'])
})
it('uses the same adjacency rule in group and direct messages', () => {
  expect([...visibleReplyQuoteIds([row('a', 'owner'), row('b', 'agent', 'a'), row('c', 'other-agent', 'a')])]).toEqual(['c'])
})
it('does not invent a quote for a message without an explicit reply target', () => {
  expect([...visibleReplyQuoteIds([row('same-text', 'owner'), row('answer', 'agent')])]).toEqual([])
})
