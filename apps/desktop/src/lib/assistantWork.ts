import { createAssistantWorkClient } from '@gugu/core/cloud/assistantWork'
import { identityDb } from './supabase'
import { getRendererSession } from './sessionPublication'
import { subscribePrivateUserEventBus,unsubscribePrivateUserEventBus } from './realtimeChannel'
import { platform } from '../platform'
import { rendererLogger } from './log'

export const assistantWorkCloud = createAssistantWorkClient(async (name,args) => identityDb.rpc(name,args),() => getRendererSession()?.user.id ?? null)

/** Reconnect and foreground re-read the account ledger, without attaching to a host. */
export function watchAssistantWork(ownerId: string,assistantId: string,refresh: () => void): () => void {
  const handle = subscribePrivateUserEventBus(ownerId,'assistant_work_changed',payload => {
    if ((payload as { assistantId?: string } | null)?.assistantId === assistantId) refresh()
  },{ onSubscribed: refresh })
  const visible = () => { if (document.visibilityState === 'visible') refresh() }
  document.addEventListener('visibilitychange',visible)
  window.addEventListener('online',refresh)
  const stop = platform.subscribeAppForeground(refresh,error => rendererLogger('assistant/work').warn({ error },'work foreground subscription failed'))
  return () => { unsubscribePrivateUserEventBus(handle); document.removeEventListener('visibilitychange',visible); window.removeEventListener('online',refresh); stop() }
}
