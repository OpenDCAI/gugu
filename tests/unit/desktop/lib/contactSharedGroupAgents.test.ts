import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { displayIdentity } from '../../../support/testHarness'
import { contactGroupChatsOf, sharedGroupAgentsOf } from '../../../../apps/desktop/src/lib/contactGroupChats'

const row = (patch: Partial<ChatItem>): ChatItem => ({
  id: 'x', kind: 'group', status: 'active', name: 'X', created_at: '2026-10-01T00:00:00Z', last_message_at: null,
  last_message_preview: null, unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1, ...patch,
})

describe('通讯录「群聊」从会话投影派生', () => {
  it('只取活跃的群;成员数、静音、我的角色都来自投影那一行', () => {
    const chats = [
      row({ id: 'group-1', name: 'One', avatar: 'a.png', public_id: 7, member_user_ids: ['me', 'agent-a'], is_muted: true, my_role: 'owner' }),
      row({ id: 'group-2', status: 'stopped' }),
      row({ id: 'dm-1', kind: 'dm', peer_user_id: 'friend' }),
      row({ id: 'topic-1', kind: 'topic', member_user_ids: ['me'] }),
    ]
    expect(contactGroupChatsOf(chats)).toEqual([
      { id: 'group-1', public_id: 7, kind: 'group', name: 'One', avatar_url: 'a.png', member_count: 2, is_muted: true, my_role: 'owner', member_user_ids: ['me', 'agent-a'] },
    ])
  })

  it('群里别人的 agent:去重、按显示名排,不含我自己的 agent 和人', () => {
    const groups = contactGroupChatsOf([
      row({ id: 'group-1', member_user_ids: ['me', 'other-owner', 'agent-b', 'agent-a', 'own-agent'] }),
      row({ id: 'group-2', member_user_ids: ['me', 'agent-a', 'human-friend'] }),
    ])
    const identities = {
      'agent-b': displayIdentity('agent-b', { type: 'agent', display_name: 'Zeta', owner_user_id: 'other-owner' }),
      'human-friend': displayIdentity('human-friend', { display_name: 'Friend' }),
      'agent-a': displayIdentity('agent-a', { type: 'agent', display_name: 'Alpha', owner_user_id: 'other-owner' }),
      'own-agent': displayIdentity('own-agent', { type: 'agent', display_name: 'Mine', owner_user_id: 'me' }),
    }
    expect(sharedGroupAgentsOf(groups, identities, 'me').map((agent) => agent.id)).toEqual(['agent-a', 'agent-b'])
    expect(sharedGroupAgentsOf(groups, identities, null)).toEqual([])
  })
})
