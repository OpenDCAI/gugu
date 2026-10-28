import { assistantWorkReads } from '@/lib/assistantWorkShell'
import { createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { chatDb } from '@/lib/supabase'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '@/lib/realtimeChannel'
import type { AssistantPanelBridge, AssistantPanelWindow } from '@/lib/assistantPanelBridge'
import { assistantPanelCloud, assistantPrivateChat, assertAssistantPanelOwner, personalAssistant, queueAssistantAppChange } from './assistant-panel-cloud'
import { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events'
import { assistantPanelCacheStore } from './assistant-panel-cache'

const bridge: AssistantPanelBridge = {
  work: assistantWorkReads,
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
      cache: assistantPanelCacheStore().files(ownerId,assistantId),
      assertCurrent: () => assertAssistantPanelOwner(ownerId),
      readBody: (item,signal) => readAssistantPanelBody(item,{ ...access(),signal }),
      upload: (name,bytes) => uploadAssistantPanelBody({ ...access(),label: name,bytes }),
      discard: async itemId => {
        assertAssistantPanelOwner(ownerId)
        const { error } = await chatDb.rpc('workspace_delete_as',{ p_item_id: itemId,p_as_user_id: ownerId }).abortSignal(AbortSignal.timeout(10_000))
        assertAssistantPanelOwner(ownerId)
        if (error) throw error
      },
      changed: () => window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED,{ detail: { ownerId,assistantId,deviceId } })),
    })
  },
  subscribeChanges(ownerId,listener,domain='panel') {
    assertAssistantPanelOwner(ownerId)
    const handle = domain==='work'
      ? subscribePrivateUserEventBus(ownerId,'assistant_work_changed',listener,{onSubscribed:()=>listener()})
      : subscribePrivateUserEventBus(ownerId,'assistant_panel_changed',listener,{onSubscribed:()=>listener()})
    return () => unsubscribePrivateUserEventBus(handle)
  },
  personalAssistant,
  privateChat: assistantPrivateChat,
  queueNotice: queueAssistantAppChange,
}

/** App entry only: install before the embedded session-page bundle mounts. */
export function installAssistantPanelHost(w: Window = window): void {
  void assistantPanelCacheStore().ready;
  (w as AssistantPanelWindow).__GUGU_ASSISTANT_PANEL__ = bridge
}
