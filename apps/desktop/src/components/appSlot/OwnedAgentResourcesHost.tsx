import { i18n } from '@/i18n/runtime'
import { useCallback, useEffect } from 'react'
import { chatTabSlotKey, readShellSlots } from '@/lib/shellSlots'
import { readChatSummary } from '@/lib/chatSummariesBridge'
import { isOwnedAgentPeer } from '@/lib/ownedAgentConversation'
import { ownedAgentResourceHost, canTakeOwnedAgentResource, hostOwnedAgentResources, OWNED_AGENT_RESOURCE_HOST_REQUEST, clearOwnedAgentResources, useOwnedAgentResourceHosts, type OwnedAgentResourceHost } from '@/lib/ownedAgentResources'
import { panelTabOf, openPanelItem, closeChatTab } from '@/session/renderer/features/chats/chat-tabs/chat-layouts'
import { installOwnedAgentResourceTabs } from '@/lib/ownedAgentResources'
import { readSessionpageViewRequestBridge } from '@/lib/sessionpageViewRequestBridge'
import { notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { GroupTabContent } from './GroupTabContent'
import { ChatTabPortals } from './ChatTabHosts'
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
    <ChatTabPortals chatId={chatId} topic={() => null} info={() => null} panel={tab =>
      <GroupTabContent chatId={chatId} tabId={tab.tabId} item={tab.item} tabbed inWindow={readShellSlots()?.getSlots().get(chatTabSlotKey(chatId, tab.tabId))?.ownerDocument !== document} mobile={false} visible={tab.shown} onOpenWith={opener.openWith} />
    } />
  </>
}
