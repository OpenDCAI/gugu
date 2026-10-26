import { createAssistantWorkClient } from '@gugu/core/cloud/assistantWork'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { withAssistantPanelReadDeadline } from '@gugu/core/cloud/assistantPanelRead'
import { identityDb } from './supabase'
import { getRendererSession } from './sessionPublication'
import { platform } from '../platform'
import { rendererLogger } from './log'
import {requireAssistantPanelBridge} from './assistantPanelBridge'
import {getAgentPresenceSnapshot,subscribeAgentPresence} from './agentPresenceStore'

type WorkClient=ReturnType<typeof createAssistantWorkClient>
function read<T>(action:(client:WorkClient)=>Promise<T>):Promise<T> {
  return withAssistantPanelReadDeadline(signal=>{
    const client=createAssistantWorkClient(async(name,args)=>{
      const response=await identityDb.rpc(name,args).abortSignal(signal)
      // PostgREST resolves fetch failures as status 0. Keep both the transport
      // status and semantic code so fixed failures take priority over retries.
      if(response.error&&(response.status===0||response.status>=500)) {
        throw new AssistantPanelError(response.error.code||'unavailable',response.error.message,undefined,undefined,response.status)
      }
      return response
    },()=>getRendererSession()?.user.id??null)
    return action(client)
  })
}
// Pagination shares one cancellation signal and one deadline for the whole read.
const client:WorkClient={
  get:(...args)=>read(client=>client.get(...args)),
  list:(...args)=>read(client=>client.list(...args)),
  history:(...args)=>read(client=>client.history(...args)),
  listAll:(...args)=>read(client=>client.listAll(...args)),
  historyAll:(...args)=>read(client=>client.historyAll(...args)),
}

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
