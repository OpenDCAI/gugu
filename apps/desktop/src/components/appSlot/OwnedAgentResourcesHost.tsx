import { i18n } from '@/i18n/runtime'
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { readShellSlots } from '@/lib/shellSlots'
import { readChatSummary } from '@/lib/chatSummariesBridge'
import { isOwnedAgentPeer } from '@/lib/ownedAgentConversation'
import { ownedAgentResourceSlotKey, ownedAgentResourceHost, canTakeOwnedAgentResource, hostOwnedAgentResources, OWNED_AGENT_RESOURCE_HOST_REQUEST, clearOwnedAgentResources, useOwnedAgentResourceHosts, type OwnedAgentResourceHost } from '@/lib/ownedAgentResources'
import { panelTabsOf, panelTabOf, openPanelItem, closeChatTab, type ChatPanelTab } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'
import { installOwnedAgentResourceTabs } from '@/lib/ownedAgentResources'
import { readSessionpageViewRequestBridge } from '@/lib/sessionpageViewRequestBridge'
import { notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { GroupTabContent } from './GroupTabContent'
import { useChatOpener } from './useChatOpener'

installOwnedAgentResourceTabs({ read: panelTabOf, open: openPanelItem, close: closeChatTab })

/** Resource hosts live independently of the retired owned-agent IM message list. */
export function OwnedAgentResourcesHost({ ownerId }: { ownerId: string }) {
  const hosts = useOwnedAgentResourceHosts()
  useEffect(() => {
    const restore = (event: Event) => {
      const target = (event as CustomEvent<OwnedAgentResourceHost>).detail
      if (target && !ownedAgentResourceHost(ownerId, target.chatId) && isOwnedAgentPeer(readChatSummary(target.chatId)?.peerUserId)) hostOwnedAgentResources(ownerId, target.chatId, target)
    }
    window.addEventListener(OWNED_AGENT_RESOURCE_HOST_REQUEST, restore)
    return () => { window.removeEventListener(OWNED_AGENT_RESOURCE_HOST_REQUEST, restore); clearOwnedAgentResources(ownerId) }
  }, [ownerId])
  return <>{hosts.filter(host => host.ownerId === ownerId).map(host => <ResourceHost key={host.chatId} {...host} />)}</>
}

function ResourceHost({ ownerId, chatId }: OwnedAgentResourceHost) {
  const show = useCallback((chatId: string, tabId: string) => {
    const target = ownedAgentResourceHost(ownerId, chatId)
    const open = readSessionpageViewRequestBridge()?.openChatResource
    if (!open || !target) { notify({ tier: 'error', title: i18n.t('shell.errors.taskBridgeUnavailable', { ns: 'main' }) }); return }
    void open({ projectId: target.projectId, sessionId: target.sessionId, chatId, sourceTabId: tabId }).catch(error => notify({ tier: 'error', title: messageForUser(error) }))
  }, [ownerId])
  const opener = useChatOpener(chatId, show, () => canTakeOwnedAgentResource(ownerId, chatId))
  return <>
    {opener.overlay}
    <ResourcePortals chatId={chatId} panel={tab =>
      <GroupTabContent chatId={chatId} tabId={tab.tabId} item={tab.item} tabbed inWindow={readShellSlots()?.getSlots().get(ownedAgentResourceSlotKey(chatId, tab.tabId))?.ownerDocument !== document} mobile={false} visible={tab.shown} onOpenWith={opener.openWith} />
    } />
  </>
}

const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
/** Legacy chat blocks may still be restoring; they must not replace this native resource's slot. */
const ResourcePortals = observer(function ResourcePortals({ chatId, panel }: { chatId: string; panel: (tab: ChatPanelTab) => ReactNode }) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? EMPTY_SLOTS)
  return <>{panelTabsOf(chatId).map(tab => {
    const element = entries.get(ownedAgentResourceSlotKey(chatId, tab.tabId))
    return element ? createPortal(panel(tab), element, tab.tabId) : null
  })}</>
})
