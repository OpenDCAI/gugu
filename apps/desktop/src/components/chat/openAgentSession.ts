import { appState } from '@renderer/lib/stores/app-state'
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names'
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { openSessionOnScreen } from '@renderer/features/chats/open-chat'
import { screenLayout } from '@renderer/app/screen-layout'
import { focusScreenBlock, isScreenView } from '@renderer/app/screen-layout-actions'
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session'

async function openInAgentPane(target: { projectId: string; sessionId: string }): Promise<void> {
  const host = isScreenView(appState.navigation.currentViewId) ? screenLayout.recentSession : undefined
  if (!host) {
    openSessionOnScreen(target, true)
    return
  }
  await appState.projects.ensureMounted(target.projectId)
  const manager = appState.projects.projects.get(target.projectId)?.mountedProject?.sessionManager
  if (!manager) throw new Error('会话所属项目尚未加载，请重试。')
  await manager.provisionSession(target.sessionId)
  openSessionInSessionWhenReady({ ...target, host })
  const blockId = screenLayout.blockOfSession(host.sessionId)
  if (blockId) focusScreenBlock(blockId)
}

/** 点击群里的署名，打开这个身份绑定的会话；不按显示名猜，也不创建新的私聊。 */
export async function openAgentSession(agentUserId: string): Promise<void> {
  if (!sessionAgentNames.isLoaded) await sessionAgentNames.load()
  for (const [sessionId, identity] of sessionAgentNames.identities) {
    if (identity.agentUserId !== agentUserId) continue
    for (const project of appState.projects.projects.values()) {
      if (project.mountedProject?.sessionManager.sessions.has(sessionId)) {
        await openInAgentPane({ projectId: project.id, sessionId })
        return
      }
    }
    const manager = sessionRegistry.get(sessionId)
    if (manager) {
      await openInAgentPane({ projectId: manager.projectId, sessionId })
      return
    }
  }
  const remote = remoteHostsStore.allListedSessions().find(({ summary }) => summary.agent?.userId === agentUserId)
  if (remote) {
    await openInAgentPane({ projectId: remote.summary.projectId, sessionId: remote.summary.conversationId })
    return
  }
  throw new Error('没有找到这个 Agent 对应的会话，请确认所属机器已连接且会话列表已加载。')
}
