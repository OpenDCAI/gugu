import { createAssistantWorkClient } from '@gugu/core/cloud/assistantWork'
import { identityDb } from './supabase'
import { getRendererSession } from './sessionPublication'
import { subscribePrivateUserEventBus,unsubscribePrivateUserEventBus } from './realtimeChannel'
import { platform } from '../platform'
import { rendererLogger } from './log'
import {installAssistantWorkReadBridge} from './assistantWorkReadBridge'
import {getAgentPresenceSnapshot,subscribeAgentPresence} from './agentPresenceStore'

const client = createAssistantWorkClient(async (name,args) => identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000)),() => getRendererSession()?.user.id ?? null)

/** Reconnect and foreground re-read the account ledger, without attaching to a host. */
function watch(ownerId: string,assistantId: string,refresh: () => void): () => void {
  const handle = subscribePrivateUserEventBus(ownerId,'assistant_work_changed',payload => {
    if ((payload as { assistantId?: string } | null)?.assistantId === assistantId) refresh()
  },{ onSubscribed: refresh })
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange',visible)
  window.addEventListener('online',refresh)
  const stop = platform.subscribeAppForeground(refresh,error => rendererLogger('assistant/work').warn({ error },'work foreground subscription failed'))
  return () => { unsubscribePrivateUserEventBus(handle); document.removeEventListener('visibilitychange',visible); window.removeEventListener('online',refresh); stop() }
}

/** Shared by desktop and mobile App roots; readers in other bundles call this shell. */
export function installAssistantWorkShell(){
  return installAssistantWorkReadBridge({client,watch,presence:getAgentPresenceSnapshot,subscribePresence:subscribeAgentPresence})
}
