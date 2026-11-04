// @@@task-shell-port (#5012) — 网页版壳对会话页壳口的应答表。
//
// 网页版里壳就是这个浏览器页面本身,会话页嵌在它里面,所以壳通道的应答是同一文档内的函数调用。
// 账号侧的活(给会话开账号、查名片、开私聊)壳委托给宿主的 `sessionpageIdentity.*`:登录态由壳按次交给
// 宿主(session-shell-auth-handoff.ts),roster 在宿主机上,两样只有宿主能一起拿到。壳仍是应答方:
// 分享名片由壳用自己的通讯录数据打开(与桌面版同一条 UI 事件 → MainLayout → SharePosterDialog)。
import { UI_EVENTS } from '@/lib/uiEvents'
import { createRPCClient } from '@/session/shared/lib/ipc/rpc'
import type { SessionShellAnswers, SessionShellInvoke } from '@/session/shared/lib/ipc/shell-port'
import type { SessionpageIdentityRouter } from '@/session/shared/lib/ipc/sessionpage-identity-contract'

export function createWebSessionShellAnswers(hostInvoke: SessionShellInvoke): SessionShellAnswers {
  const host = createRPCClient<SessionpageIdentityRouter>(hostInvoke)
  return {
    // 壳自己就是报错的目的地:EmdashSessionFrame 在调用前已 console.error + 显示错误卡,这里无事可做。
    fatalBoot: async () => undefined,
    agentCard: (sessionId) => host.sessionpageIdentity.agentCard(sessionId),
    agentNames: () => host.sessionpageIdentity.agentNames(),
    sessionPeers: (...args) => host.sessionpageIdentity.sessionPeers(...args),
    ensureAgentAddress: (input) => host.sessionpageIdentity.ensureAgentAddress(input),
    // 点了必须有反应:有身份 → 与桌面版同一条 UI 事件打开分享名片;没身份 → 同一条「不可分享」toast。
    shareAgent: async (sessionId) => {
      const card = await host.sessionpageIdentity.agentCard(sessionId)
      if (!card) {
        window.dispatchEvent(new CustomEvent(UI_EVENTS.sessionpageShareAgentUnavailable, { detail: null }))
        return false
      }
      // 分享浮层要摆会话 id(#6093);名片只答「是哪个 agent」,问题那一半在这里补上。
      window.dispatchEvent(new CustomEvent(UI_EVENTS.sessionpageShareAgent, { detail: { ...card, sessionId } }))
      return true
    },
    openFeedback: async () => {
      window.dispatchEvent(new CustomEvent(UI_EVENTS.sessionpageOpenFeedback))
      return true
    },
  }
}
