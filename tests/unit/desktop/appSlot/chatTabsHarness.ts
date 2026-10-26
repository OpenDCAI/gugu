import type { MessageItem } from '@gugu/core/shared/types/chat'
import { observer } from 'mobx-react-lite'
import { act, createElement, Fragment } from 'react'
import { GroupTabContent } from '../../../../apps/desktop/src/components/appSlot/GroupTabContent'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { askChat, shownPanelTab, type ChatOpenAsk } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { AuthContext } from '../../../../apps/desktop/src/store/auth'

export interface ChatTabsProps {
  chatId: string
  /** In a block, whose strip names the tab (ChatAreaPanel's `blockHost`). */
  tabbed?: boolean
  mobile?: boolean
  visible?: boolean
  onForward?: (message: MessageItem) => void
}

/**
 * What ChatAreaPanel draws of a chat's tabs, without the rest of it: the chat's opener (its overlay — the open-with pick,
 * an App's files, a file that cannot open) and the panel tab on screen, as one tab of the strip shows it.
 */
export const ChatTabs = observer(function ChatTabs({ chatId, tabbed = false, mobile = false, visible, onForward }: ChatTabsProps) {
  const opener = useChatOpener(chatId)
  const tab = shownPanelTab(chatId)
  return createElement(Fragment, null, opener.overlay, tab
    ? createElement(GroupTabContent, { key: tab.tabId, chatId, tabId: tab.tabId, item: tab.item, tabbed, inWindow: tab.inWindow, mobile, visible, onForward, onOpenWith: opener.openWith })
    : null)
})

/** The chat's tabs, as a signed-in person sees them (the group's shared packages are read for one). */
export const chatTabs = (props: ChatTabsProps, userId = 'user-1') =>
  createElement(AuthContext.Provider, { value: { user: { id: userId } } as never }, createElement(ChatTabs, props))

/** Ask the chat, as the shell does (MainLayout, a link): kept for it, and the chat on screen told. */
export function ask(chatId: string, what: ChatOpenAsk): void {
  act(() => {
    askChat(chatId, what)
    window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
  })
}

/** The item of the panel tab on screen; null: only the chat. */
export const shownItem = (chatId: string) => shownPanelTab(chatId)?.item ?? null
