import { describe, expect, it } from 'vitest'
import { agentNamesFromPeers } from '../../../../apps/desktop/src/session/shared/lib/ipc/shell-port'

// 侧栏「这一行是谁」= 名册(session_peers)那一份的投影:名字就是名册行上的 identity.users.display_name,
// ❌ 本机花名册里那个旧候选名;名册里没有的会话(还没身份)不出行,❌ 编一个名字。
describe('session-page agent display names', () => {
  it('projects the session_peers rows: canonical identity.users.display_name, session id and agent id', () => {
    const peers = [{
      identity: { users: { id: 'agent-1', gugu_number: null, display_name: 'Codex 8' } },
      sessionId: 'conv-1',
      title: 'fix the build',
      project: 'gugu',
      status: null,
      detail: null,
      pinned: false,
      last_active_at: null,
    }]
    expect(agentNamesFromPeers(peers as never)).toEqual([
      { conversationId: 'conv-1', displayName: 'Codex 8', agentUserId: 'agent-1' },
    ])
  })

  it('a session with no identity yet is simply absent (no row in session_peers)', () => {
    expect(agentNamesFromPeers([])).toEqual([])
  })
})
