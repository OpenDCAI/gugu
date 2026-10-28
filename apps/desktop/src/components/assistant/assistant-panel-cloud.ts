import { createAssistantPanelClient, AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { createAssistantPanelOutbox } from '@gugu/core/cloud/assistantPanelOutbox'
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'
import { identityDb, chatDb } from '@/lib/supabase'
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { rendererLogger } from '@/lib/log'
import { onMyAssistantChange } from '@/lib/myAssistant'
import { assistantAppChangeSchema, type AssistantAppChange } from '@/session/shared/extensions/assistant-app'

const accountId = () => getRendererSession()?.user.id ?? null
export const assistantPanelCloud = createAssistantPanelClient(async (name,args) => {
  const { data,error,status } = await identityDb.rpc(name,args).abortSignal(AbortSignal.timeout(10_000))
  return { data,error,status }
},accountId)

export function assertAssistantPanelOwner(expectedOwner: string | null): asserts expectedOwner is string {
  if (!expectedOwner || accountId() !== expectedOwner) throw new AssistantPanelError('account-changed','Assistant panel account changed')
}

export async function personalAssistant(owner: string): Promise<string | null> {
  assertAssistantPanelOwner(owner)
  const { data,error,status } = await identityDb.from('agent_provisions').select('agent_user_id,device_id,member_key,phase,created_at')
    .eq('owner_user_id',owner).eq('member_key','assistant').abortSignal(AbortSignal.timeout(10_000))
  assertAssistantPanelOwner(owner)
  if (error) throw new AssistantPanelError(error.code,'Could not read the personal assistant',undefined,undefined,status)
  return pickAssistant((data ?? []) as AssistantProvisionRow[])?.agentId ?? null
}

const outbox = createAssistantPanelOutbox({ storage: {
  getItem: key => window.localStorage.getItem(key),setItem: (key,value) => window.localStorage.setItem(key,value),
},accountId,assistantId: personalAssistant,
  send: (assistant,notice) => assistantPanelCloud.notice(assistant,assistantAppChangeSchema.parse(notice)),
})
const log = rendererLogger('assistant/panel')
let retry: ReturnType<typeof setTimeout> | undefined
let delay = 1000

/** Retries do not involve the execution host and never change the saved result. */
async function flushNotices(): Promise<void> {
  clearTimeout(retry)
  const owner = accountId()
  if (!owner) return
  try { await outbox.flush(owner); delay = 1000 }
  catch {
    log.warn({},'Saved App change publication will retry')
    // Only a failed send is retried. Notices left with no assistant to take them wait for one (onMyAssistantChange below).
    try {
      if (accountId() === owner && outbox.hasPending(owner)) {
        retry = setTimeout(() => { void flushNotices() },delay)
        delay = Math.min(delay * 2,60_000)
      }
    } catch { log.warn({},'Saved App change outbox could not be read') }
  }
}
observeRendererSession(() => { delay = 1000; void flushNotices() })
onMyAssistantChange(() => { delay = 1000; void flushNotices() })
if (typeof window !== 'undefined') window.addEventListener('online',() => { delay = 1000; void flushNotices() })
void flushNotices()

export async function queueAssistantAppChange(
  change: AssistantAppChange, assistantId: string | undefined, expectedOwnerId: string | null,
) {
  assertAssistantPanelOwner(expectedOwnerId)
  const notice = assistantAppChangeSchema.parse(change)
  try { return await outbox.enqueue(expectedOwnerId,notice,assistantId) }
  finally { void flushNotices() }
}

export async function assistantPrivateChat(ownerId: string, assistantId: string): Promise<string> {
  assertAssistantPanelOwner(ownerId)
  const { data,error,status } = await chatDb.rpc('open_dm',{ p_target_user_id: assistantId }).abortSignal(AbortSignal.timeout(10_000))
  assertAssistantPanelOwner(ownerId)
  if (error) throw new AssistantPanelError(error.code,'PANEL_PRIVATE_FOLDER_UNAVAILABLE',undefined,undefined,status)
  if (typeof data !== 'string') throw new AssistantPanelError('missing-identity','PANEL_PRIVATE_FOLDER_UNAVAILABLE')
  return data
}
