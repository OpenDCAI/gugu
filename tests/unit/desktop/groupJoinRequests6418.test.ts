// @vitest-environment jsdom
//
// @@@6418 「我能审的群」与跨群读取申请。判据:只读我是群主/管理员且未解散的群;新的在前;
// 任何一个群读失败整体失败(少读一个群 = 管理员以为没人申请)。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatService } from '../../../apps/desktop/src/lib/chat'
import { listManagedGroupJoinRequests, managedGroupChats } from '../../../apps/desktop/src/lib/groupJoinRequests'
import type { ContactGroupChat } from '../../../packages/core/src/shared/types/contacts'
import type { GroupJoinRequest } from '../../../packages/core/src/shared/types/chat'

afterEach(() => { vi.restoreAllMocks() })

function group(id: string, my_role: ContactGroupChat['my_role'], status: ContactGroupChat['status'] = 'active'): ContactGroupChat {
  return { id, kind: 'group', name: `群-${id}`, avatar_url: null, status, member_count: 3, is_muted: false, my_role }
}
function request(id: string, chat_id: string, created_at: string): GroupJoinRequest {
  return { id, chat_id, requester_user_id: `u-${id}`, requester_type: 'human', requested_by_user_id: null, message: null, status: 'pending', created_at }
}

describe('#6418 managedGroupChats', () => {
  it('只留我是群主/管理员、且没解散的群', () => {
    const groups = [group('a', 'owner'), group('b', 'admin'), group('c', 'member'), group('d', null), group('e', 'owner', 'archived')]
    expect(managedGroupChats(groups).map((g) => g.id)).toEqual(['a', 'b'])
  })
})

describe('#6418 listManagedGroupJoinRequests', () => {
  it('逐群读、带上群信息、新的在前', async () => {
    const list = vi.spyOn(chatService, 'listGroupJoinRequests').mockImplementation(async (chatId: string) => (
      chatId === 'a' ? [request('r1', 'a', '2026-09-24T01:00:00Z')] : [request('r2', 'b', '2026-09-24T02:00:00Z')]
    ))
    const rows = await listManagedGroupJoinRequests([group('a', 'owner'), group('b', 'admin')])
    expect(list.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])
    expect(rows.map((row) => row.id)).toEqual(['r2', 'r1'])
    expect(rows[0].group).toEqual({ id: 'b', name: '群-b', avatar_url: null })
  })

  it('任何一个群读失败就整体失败', async () => {
    vi.spyOn(chatService, 'listGroupJoinRequests').mockImplementation(async (chatId: string) => {
      if (chatId === 'b') throw new Error('network down')
      return []
    })
    await expect(listManagedGroupJoinRequests([group('a', 'owner'), group('b', 'admin')])).rejects.toThrow('network down')
  })
})
