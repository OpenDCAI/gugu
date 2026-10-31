import { observer } from 'mobx-react-lite'
import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { chatTabSlotKey, readShellSlots } from '../../lib/shellSlots'
import { focusedChatTab, infoTabOf, panelTabOf, panelTabsOf, returnToOf, topicTabOf, type ChatPanelTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * In a block, each tab of the chat that is on screen has a slot the session page's engine left for it (chat-tab-providers'
 * ShellTabSlots): what it shows is drawn into it here, in the chat's own tree — its state, its Apps, its topic line.
 */
export const ChatTabPortals = observer(function ChatTabPortals({ chatId, panel, topic, info }: {
  chatId: string
  panel: (tab: ChatPanelTab) => ReactNode
  topic: () => ReactNode
  info: () => ReactNode
}) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  const topicTab = topicTabOf(chatId)
  const topicSlot = topicTab ? entries.get(chatTabSlotKey(chatId, topicTab.tabId)) : undefined
  const infoTab = infoTabOf(chatId)
  const infoSlot = infoTab ? entries.get(chatTabSlotKey(chatId, infoTab.tabId)) : undefined
  return (
    <>
      {panelTabsOf(chatId).map((tab) => {
        const element = entries.get(chatTabSlotKey(chatId, tab.tabId))
        return element ? createPortal(panel(tab), element, tab.tabId) : null
      })}
      {topicTab && topicSlot ? createPortal(topic(), topicSlot, topicTab.tabId) : null}
      {infoTab && infoSlot ? createPortal(info(), infoSlot, infoTab.tabId) : null}
    </>
  )
})

/**
 * Where there is no strip (the phone, the assistant's window): the tab in front, a whole page over the chat — its way out
 * is its back. A tab and the 上一页 it goes back to are one page here (`key`: the first of them), so going back finds that
 * page as it was (G2: a phone frame is not kept anywhere else).
 */
export const ChatTabPage = observer(function ChatTabPage({ chatId, panel, topic, info }: {
  chatId: string
  panel: (tab: ChatPanelTab) => ReactNode
  topic: () => ReactNode
  info: () => ReactNode
}) {
  const focused = focusedChatTab(chatId)
  if (focused?.kind === 'topic') return <>{topic()}</>
  if (focused?.kind === 'info') return <>{info()}</>
  const tab = focused?.kind === 'panel' ? panelTabOf(chatId, focused.tabId) : null
  if (!tab) return null
  let root = tab.tabId
  for (let back = returnToOf(chatId, root); back && panelTabOf(chatId, back); back = returnToOf(chatId, back)) root = back
  return <Fragment key={root}>{panel(tab)}</Fragment>
})
