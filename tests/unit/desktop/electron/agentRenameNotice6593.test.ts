import { describe, expect, it } from 'vitest'
import { tellAgentItWasRenamed } from '../../../../apps/desktop/electron/sessionpage/agent-rename-notice'
import {
  SessionpageLocalDeliveryRouter,
  type SessionpageDeliveryTarget,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'

// #6593 改 agent 名(社交身份)⇒ 告诉它自己的会话。走的是普通消息那条注入链:真路由器 + 一个假的会话属主,
// 读的是属主**实际收到**的字节,❌ 只看 tellAgentItWasRenamed 调没调。
const AGENT = 'renamed-agent-6593'
const SESSION = 'renamed-conversation-6593'

function ownerOf(live: boolean) {
  const injected: Array<{ sessionId: string; text: string; kind?: string }> = []
  const target: SessionpageDeliveryTarget = {
    liveSessionIdByAgent: (agentUserId) => (agentUserId === AGENT ? SESSION : null),
    deliveryKeyForSession: (sessionId) => (live && sessionId === SESSION ? SESSION : null),
    sessionProviderSurface: (key) => (key === SESSION ? { providerId: 'claude', surface: 'tui' } : null),
    tryInjectSessionMessage: async (sessionId, message) => {
      injected.push({ sessionId, text: message.text, kind: message.kind })
      return true
    },
  }
  return { router: new SessionpageLocalDeliveryRouter([target]), injected }
}

describe('telling an agent its display name changed', () => {
  it('goes to its own session through the ordinary delivery router, as a 咕咕 system notice', async () => {
    const { router, injected } = ownerOf(true)
    const verdict = await tellAgentItWasRenamed(router, { agentUserId: AGENT, displayName: '小研究员' })
    expect(verdict).toBe('accepted')
    expect(injected).toHaveLength(1)
    expect(injected[0]!.sessionId).toBe(SESSION)
    expect(injected[0]!.text).toMatch(/^<gugu_delivery route="system" from="咕咕系统" from_id="system:gugu" msg="msg:/)
    expect(injected[0]!.text).toContain('Your display name is now "小研究员"')
    expect(injected[0]!.text).toContain('there is no one to reply to')
  })

  it('does not wake a session that is not running: nothing is injected and nothing throws', async () => {
    const { router, injected } = ownerOf(false)
    await expect(tellAgentItWasRenamed(router, { agentUserId: AGENT, displayName: '小研究员' })).resolves.toBe('not-live')
    expect(injected).toHaveLength(0)
  })
})
