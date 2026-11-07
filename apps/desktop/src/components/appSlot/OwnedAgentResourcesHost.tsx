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
import { GroupTabContent } from './GroupTabContent'
import { useChatOpener } from './useChatOpener'
import { PaneContext } from '@renderer/features/tabs/pane-context'
import { getSessionView } from '@/session/renderer/features/sessions/stores/session-selectors'

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

function ResourceHost({ ownerId, chatId, projectId, sessionId }: OwnedAgentResourceHost) {
  const show = useCallback((chatId: string, tabId: string) => {
    const target = ownedAgentResourceHost(ownerId, chatId)
    const open = readSessionpageViewRequestBridge()?.openChatResource
    if (!open || !target) throw new Error(i18n.t('shell.errors.taskBridgeUnavailable', { ns: 'main' }))
    return open({ projectId: target.projectId, sessionId: target.sessionId, chatId, sourceTabId: tabId })
  }, [ownerId])
  const opener = useChatOpener(chatId, show, () => canTakeOwnedAgentResource(ownerId, chatId))
  return <>
    {opener.overlay}
    <ResourcePortals chatId={chatId} projectId={projectId} sessionId={sessionId} panel={tab =>
      <GroupTabContent chatId={chatId} tabId={tab.tabId} item={tab.item} tabbed inWindow={readShellSlots()?.getSlots().get(ownedAgentResourceSlotKey(chatId, tab.tabId))?.ownerDocument !== document} mobile={false} visible={tab.shown} onOpenWith={opener.openWith} />
    } />
  </>
}

const EMPTY_SLOTS: ReadonlyMap<string, HTMLElement> = new Map()
/** Legacy chat blocks may still be restoring; they must not replace this native resource's slot. */
const ResourcePortals = observer(function ResourcePortals({ chatId, projectId, sessionId, panel }: { chatId: string; projectId: string; sessionId: string; panel: (tab: ChatPanelTab) => ReactNode }) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(listener => slots?.subscribeSlots(listener) ?? (() => undefined), () => slots?.getSlots() ?? EMPTY_SLOTS)
  return <>{panelTabsOf(chatId).map(tab => {
    const element = entries.get(ownedAgentResourceSlotKey(chatId, tab.tabId))
    const layout = getSessionView(projectId, sessionId)?.paneLayout
    const owner = [...(layout?.groups ?? []), ...(layout?.windowPanes.values() ?? [])].find(({ pane }) => [...pane.entries.values()].some(entry => entry.kind === 'chat-resource' && (entry.state as { chatId?: string; sourceTabId?: string }).chatId === chatId && (entry.state as { sourceTabId?: string }).sourceTabId === tab.tabId))
    return element ? createPortal(<PaneContext.Provider value={owner ? { pane: owner.pane, paneId: owner.paneId, isFocusedPane: layout?.activePaneId === owner.paneId } : null}>{panel(tab)}</PaneContext.Provider>, element, tab.tabId) : null
  })}</>
})
