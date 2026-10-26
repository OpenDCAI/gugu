import { when } from 'mobx'
import type { AssistantHomePlace } from '@/lib/assistantHome'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import { rpcOn } from '@renderer/lib/ipc'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { assistantWorkdir } from './assistant-data'
import { homeSessions, homeTarget, localHomeSessions } from './assistant-home-sessions'
import { isAssistantSession } from './assistant-lineage'

/** Called for an explicitly requested piece of work, never by a panel read. */
export async function prepareAssistantSummary(home: AssistantHomePlace, assistantId: string) {
  const target = homeTarget(home)
  let stop: (() => void) | undefined
  try {
    if (target === null) stop = localHomeSessions.use()
    else {
      remoteHostsStore.start()
      if (home.kind === 'cloud' && !await remoteHostsStore.wakeCloudComputer(home.deviceId)) throw new Error('SUMMARY_PREPARATION_FAILED')
      remoteHostsStore.reconnect(home.deviceId)
      await when(() => remoteHostsStore.connectionState(home.deviceId) === 'connected',{ timeout: 60_000 })
    }
    await when(() => homeSessions(home).live && assistantWorkdir(home,assistantId).state === 'found',{ timeout: 60_000 })
    const session = homeSessions(home).sessions.find(row => isAssistantSession(row,assistantId))
    const workdir = assistantWorkdir(home,assistantId)
    if (!session || workdir.state !== 'found') throw new Error('SUMMARY_SESSION_UNAVAILABLE')
    const homeDirectory = await rpcOn(target).app.getHomeDirectory()
    return { session: { sessionId: session.conversationId,projectId: session.projectId },
      memoryDir: assistantHomePaths(homeDirectory,workdir.path,home.kind).memoryDir }
  } finally { stop?.() }
}
