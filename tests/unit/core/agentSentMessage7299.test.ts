import { describe, expect, it } from 'vitest'
import { messageItemFromRow, MESSAGES_VIEW_SELECT } from '../../../packages/core/src/cloud/messageItem'
const row = { id: 'message', chat_id: 'dm', sender_user_id: 'owner', sent_by_agent: true, agent_sender: { id: 'agent', name: 'Researcher' } }

describe('private Agent provenance in message rows (#7299)', () => {
  it('selects the same fields for history and live synchronization', () => {
    expect(MESSAGES_VIEW_SELECT.split(', ')).toEqual(expect.arrayContaining(['sent_by_agent', 'agent_sender']))
    expect(messageItemFromRow(row, 'owner')).toMatchObject({ is_mine: true, sent_by_agent: true, agent_sender: row.agent_sender })
  })
  it('retains only the public marker when viewing another person’s message', () => {
    expect(messageItemFromRow(row, 'friend')).toMatchObject({ is_mine: false, sent_by_agent: true, agent_sender: null })
  })
  it('keeps a deleted Agent’s snapshot name without an active jump target', () => {
    expect(messageItemFromRow({ ...row, agent_sender: { id: null, name: 'Researcher' } }, 'owner')?.agent_sender).toEqual({ id: null, name: 'Researcher' })
  })
  it('ordinary messages cannot acquire provenance from stale or malformed source values', () => {
    expect(messageItemFromRow({ ...row, sent_by_agent: false }, 'owner')).toMatchObject({ sent_by_agent: false, agent_sender: null })
    expect(messageItemFromRow({ ...row, agent_sender: {} }, 'owner')?.agent_sender).toBeNull()
  })
})
