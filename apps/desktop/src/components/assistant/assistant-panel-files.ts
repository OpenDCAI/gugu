import { useEffect, useMemo } from 'react'
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { getRendererSession } from '@/lib/sessionPublication'
import { chatDb } from '@/lib/supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '@/lib/realtimeChannel'
import { assistantPanelCloud, assertAssistantPanelOwner } from './assistant-panel-cloud'

import { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events'
export { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events'

/** Identical cloud access on desktop and phone. No native project is acquired. */
export function useCloudAssistantFiles(assistantId: string | null, chatId: string | null, deviceId: string | null): AssistantMachine | undefined {
  const ownerId = getRendererSession()?.user.id ?? null
  const machine = useMemo(() => {
    if (!assistantId || !chatId || !deviceId || !ownerId) return undefined
    const access = () => {
      assertAssistantPanelOwner(ownerId)
      const token = getRendererSession()?.access_token
      if (!token) throw new Error('Not signed in')
      return { token,chatId,ownerId,accountId: () => getRendererSession()?.user.id ?? null }
    }
    const changed = () => window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED,{ detail: { ownerId,assistantId,deviceId } }))
    const panel = createAssistantPanelFiles({ assistantId,deviceId,ownerId,cloud: assistantPanelCloud,
      assertCurrent: () => assertAssistantPanelOwner(ownerId),
      readBody: item => readAssistantPanelBody(item,access()),
      upload: (name,bytes,contentType) => uploadAssistantPanelBody({ ...access(),name,bytes,contentType }),
      discard: async itemId => {
        assertAssistantPanelOwner(ownerId)
        const { error } = await chatDb.rpc('workspace_delete_as',{ p_item_id: itemId,p_as_user_id: ownerId })
        assertAssistantPanelOwner(ownerId)
        if (error) throw error
      },changed,
    })
    return { deviceId,target: deviceId,projectId: `panel:${ownerId}:${assistantId}`,workspaceId: chatId,home: '',paths: panel.paths,rpc: null,panel } satisfies AssistantMachine
  },[assistantId,chatId,deviceId,ownerId])
  useEffect(() => {
    if (!machine?.panel || !ownerId) return
    const handle = subscribePrivateUserEventBus(ownerId,'assistant_panel_changed',() => machine.panel.invalidate())
    return () => unsubscribePrivateUserEventBus(handle)
  },[machine,ownerId])
  return machine
}
