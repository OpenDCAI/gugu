import { createAssistantWorkClient } from '@gugu/core/cloud/assistantWork'
import { identityDb } from './supabase'
import { getRendererSession } from './sessionPublication'
import { platform } from '../platform'
import { rendererLogger } from './log'
import {requireAssistantPanelBridge} from './assistantPanelBridge'
import {getAgentPresenceSnapshot,subscribeAgentPresence} from './agentPresenceStore'

const client = createAssistantWorkClient(async (name,args) => identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000)),() => getRendererSession()?.user.id ?? null)

/** Reconnect and foreground re-read the account ledger, without attaching to a host. */
function watch(ownerId: string,assistantId: string,refresh: () => void): () => void {
  const stopChanges = requireAssistantPanelBridge().subscribeChanges(ownerId,payload => {
    if (!payload || (payload as { assistantId?: string }).assistantId === assistantId) refresh()
  },'work')
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange',visible)
  window.addEventListener('online',refresh)
  const stop = platform.subscribeAppForeground(refresh,error => rendererLogger('assistant/work').warn({ error },'work foreground subscription failed'))
  return () => { stopChanges(); document.removeEventListener('visibilitychange',visible); window.removeEventListener('online',refresh); stop() }
}

/** Shared by desktop and mobile App roots; readers in other bundles call this shell. */
export const assistantWorkReads={client,watch,presence:getAgentPresenceSnapshot,subscribePresence:subscribeAgentPresence}
