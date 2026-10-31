import { expect, it } from 'vitest'
import { message } from '../../../support/testHarness'
import { visibleReplyQuoteIds } from '../../../../apps/desktop/src/components/chat/replyQuoteVisibility'

const row = (id: string, sender: string | null, reply: string | null = null) => message({ id, sender_user_id: sender, reply_to_message_id: reply })
it('keeps every explicit reply, including the message directly above', () => {
  expect([...visibleReplyQuoteIds([row('old', 'owner'), row('new', 'owner'), row('answer', 'agent', 'new')])]).toEqual(['answer'])
  expect([...visibleReplyQuoteIds([row('old', 'owner'), row('new', 'owner'), row('answer', 'agent', 'old')])]).toEqual(['answer'])
})
it('keeps consecutive replies without comparing authors or viewers', () => {
  expect([...visibleReplyQuoteIds([row('original', 'owner'), row('a', 'agent', 'original'), row('b', 'agent', 'a'), row('c', 'owner', 'b')])]).toEqual(['a', 'b', 'c'])
})
it('keeps an explicit target even when its author or history is unavailable', () => {
  expect([...visibleReplyQuoteIds([row('answer', null, 'not-loaded')])]).toEqual(['answer'])
})
it('keeps replies sent as a human through a message tool', () => {
  const sent = { ...row('tool-sent', 'owner', 'question'), sent_by_agent: true }
  expect([...visibleReplyQuoteIds([row('question', 'agent'), sent])]).toEqual(['tool-sent'])
})
it('does not invent a target from repeated text, position, or a tool-send flag', () => {
  const sent = { ...row('tool-sent', 'agent'), sent_by_agent: true }
  expect([...visibleReplyQuoteIds([row('same-text', 'owner'), sent, row('answer', 'agent')])]).toEqual([])
})
it('does not infer a target from a quoted author or preview alone', () => {
  expect([...visibleReplyQuoteIds([message({ reply_to_message_id: null, reply_to_sender_user_id: 'owner', reply_to_content: 'Original' })])]).toEqual([])
})
