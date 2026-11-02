import { useCallback, useEffect } from 'react'
import { readChatSummary } from '@/lib/chatSummariesBridge'
import { isOwnedAgentPeer } from '@/lib/ownedAgentConversation'
import { hostOwnedAgentResources, OWNED_AGENT_RESOURCE_HOST_REQUEST, clearOwnedAgentResources, useOwnedAgentResourceHosts, type OwnedAgentResourceHost } from '@/lib/ownedAgentResources'
import { notify } from '@/lib/notices'
import { messageForUser } from '@/lib/userFacingError'
import { GroupTabContent } from './GroupTabContent'
import { ChatTabPortals } from './ChatTabHosts'
import { useChatOpener } from './useChatOpener'

/** Resource hosts live independently of the retired owned-agent IM message list. */
export function OwnedAgentResourcesHost({ ownerId }: { ownerId: string }) {
  const hosts = useOwnedAgentResourceHosts()
  useEffect(() => {
    const restore = (event: Event) => {
      const target = (event as CustomEvent<OwnedAgentResourceHost>).detail
      if (target && isOwnedAgentPeer(readChatSummary(target.chatId)?.peerUserId)) hostOwnedAgentResources(ownerId, target.chatId, target)
    }
    window.addEventListener(OWNED_AGENT_RESOURCE_HOST_REQUEST, restore)
    return () => { window.removeEventListener(OWNED_AGENT_RESOURCE_HOST_REQUEST, restore); clearOwnedAgentResources(ownerId) }
  }, [ownerId])
  return <>{hosts.filter(host => host.ownerId === ownerId).map(host => <ResourceHost key={host.chatId} {...host} />)}</>
}

function ResourceHost({ chatId, projectId, sessionId }: OwnedAgentResourceHost) {
  const show = useCallback((chatId: string, tabId: string) => {
    void import('@/session/renderer/features/sessions/open-chat-resource').then(({ openChatResource }) =>
      openChatResource({ projectId, sessionId, chatId, sourceTabId: tabId })
    ).catch(error => notify({ tier: 'error', title: messageForUser(error) }))
  }, [projectId, sessionId])
  const opener = useChatOpener(chatId, show)
  return <>
    {opener.overlay}
    <ChatTabPortals chatId={chatId} topic={() => null} info={() => null} panel={tab =>
      <GroupTabContent chatId={chatId} tabId={tab.tabId} item={tab.item} tabbed inWindow={tab.inWindow} mobile={false} visible={tab.shown} onOpenWith={opener.openWith} />
    } />
  </>
}
