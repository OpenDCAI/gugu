import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { chatDb } from '@/lib/supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '@/lib/realtimeChannel'
import type { AssistantPanelBridge, AssistantPanelWindow } from '@/lib/assistantPanelBridge'
import { assistantPanelCloud, assertAssistantPanelOwner, personalAssistant, queueAssistantAppChange } from './assistant-panel-cloud'
import { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events'

const bridge: AssistantPanelBridge = {
  accountId: () => getRendererSession()?.user.id ?? null,
  subscribeAccount: listener => observeRendererSession(() => listener()),
  files({ ownerId,assistantId,chatId,deviceId }) {
    assertAssistantPanelOwner(ownerId)
    const access = () => {
      assertAssistantPanelOwner(ownerId)
      const token = getRendererSession()?.access_token
      if (!token) throw new AssistantPanelError('signed-out','PANEL_SIGNED_OUT')
      return { token,chatId,ownerId,accountId: () => getRendererSession()?.user.id ?? null }
    }
    return createAssistantPanelFiles({ ownerId,assistantId,deviceId,cloud: assistantPanelCloud,
      assertCurrent: () => assertAssistantPanelOwner(ownerId),
      readBody: item => readAssistantPanelBody(item,access()),
      upload: (name,bytes,contentType) => uploadAssistantPanelBody({ ...access(),name,bytes,contentType }),
      discard: async itemId => {
        assertAssistantPanelOwner(ownerId)
        const { error } = await chatDb.rpc('workspace_delete_as',{ p_item_id: itemId,p_as_user_id: ownerId }).abortSignal(AbortSignal.timeout(10_000))
        assertAssistantPanelOwner(ownerId)
        if (error) throw error
      },
      changed: () => window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED,{ detail: { ownerId,assistantId,deviceId } })),
    })
  },
  subscribeChanges(ownerId,listener) {
    assertAssistantPanelOwner(ownerId)
    const handle = subscribePrivateUserEventBus(ownerId,'assistant_panel_changed',listener)
    return () => unsubscribePrivateUserEventBus(handle)
  },
  personalAssistant,
  async privateChat(ownerId,assistantId) {
    assertAssistantPanelOwner(ownerId)
    const { data,error } = await chatDb.rpc('open_dm',{ p_target_user_id: assistantId }).abortSignal(AbortSignal.timeout(10_000))
    assertAssistantPanelOwner(ownerId)
    if (error || typeof data !== 'string') throw new AssistantPanelError('missing-identity','PANEL_PRIVATE_FOLDER_UNAVAILABLE')
    return data
  },
  queueNotice: queueAssistantAppChange,
}

/** App entry only: install before the embedded session-page bundle mounts. */
export function installAssistantPanelHost(w: Window = window): void {
  (w as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__ = bridge
}
