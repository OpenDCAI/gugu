import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { projectTurnFailureMessages } from '../../../../apps/desktop/src/lib/projectTurnFailureMessages'

function row(id: string, agent = 'agent', thread: string | null = null, reason: string | null = 'network'): MessageItem {
  return { id, chat_id: 'chat', thread_root_id: thread, seq: 1, sender_user_id: agent, content: id,
    content_type: reason ? 'system' : 'text', client_message_id: reason ? `turn-failure:${id}:${reason}` : null,
    created_at: '2026-01-01T00:00:00Z', reply_to_message_id: null, retracted_at: null, reactions: [], is_mine: false,
    delivered: true, delivery_status: null, to_user_ids: null }
}

describe('failure card projection', () => {
  it('merges consecutive failures and keeps the newest cause and identity without mutating input', () => {
    const messages = [row('a'), row('b', 'agent', null, 'timeout')]
    expect(projectTurnFailureMessages(messages)).toEqual([{ ...messages[1], turnFailure: { count: 2, recovered: false } }])
    expect(messages[0]).not.toHaveProperty('turnFailure')
    expect(messages[1]).not.toHaveProperty('turnFailure')
  })
  it('breaks a run on a normal message and folds all earlier runs when that agent replies', () => {
    const messages = [row('a'), row('human', 'human', null, null), row('b'), row('reply', 'agent', null, null)]
    const result = projectTurnFailureMessages(messages)
    expect(result.map(message => message.id)).toEqual(['a', 'human', 'b', 'reply'])
    expect(result[0].turnFailure).toEqual({ count: 1, recovered: true })
    expect(result[2].turnFailure).toEqual({ count: 1, recovered: true })
  })
  it('keeps agents, chats and thread lines independent, including recovery', () => {
    const messages = [row('a'), row('other-agent', 'other'), row('thread', 'agent', 'thread'),
      { ...row('other-chat'), chat_id: 'other-chat' }, row('reply', 'agent', null, null)]
    expect(projectTurnFailureMessages(messages).map(message => message.turnFailure?.recovered)).toEqual([true, false, false, false, undefined])
  })
  it('does not recover on a system row, retraction, or failed local reply', () => {
    for (const reply of [row('system', 'agent', null, 'quota'), { ...row('deleted', 'agent', null, null), retracted_at: 'now' },
      { ...row('failed', 'agent', null, null), local_send_state: 'failed' as const }]) {
      expect(projectTurnFailureMessages([row('a'), reply])[0].turnFailure?.recovered).toBe(false)
    }
  })
  it('leaves model status, pending delivery, unknown markers and ordinary system messages alone', () => {
    const messages = ['quota', 'modelUnavailable', 'notAdmitted', 'undelivered', 'futureReason'].map(reason => row(reason, 'agent', null, reason))
    expect(projectTurnFailureMessages(messages)).toEqual(messages)
  })
})
