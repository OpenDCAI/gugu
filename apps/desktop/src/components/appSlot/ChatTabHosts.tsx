import { observer } from 'mobx-react-lite'
import { Fragment, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Folder, Plus } from '@/lib/icons'
import { chatTabSlotKey, readShellSlots } from '../../lib/shellSlots'
import { folderItem } from '../../session/renderer/features/chats/chat-tabs/chat-panel-item'
import { focusedChatTab, openPanelItem, panelTabOf, panelTabsOf, returnToOf, topicTabOf, type ChatPanelTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { useChatFolderName } from '../chat/chatFolderName'
import { OpenAppMenuItems } from '../chat/OpenAppMenuItems'
import { IconButton } from '../ui/IconButton'
import { Menu, MenuItem } from '../ui/Menu'

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()

/**
 * In a block, each tab of the chat that is on screen has a slot the session page's engine left for it (chat-tab-providers'
 * ShellTabSlots): what it shows is drawn into it here, in the chat's own tree — its state, its Apps, its topic line.
 */
export const ChatTabPortals = observer(function ChatTabPortals({ chatId, panel, topic }: {
  chatId: string
  panel: (tab: ChatPanelTab) => ReactNode
  topic: () => ReactNode
}) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  const topicTab = topicTabOf(chatId)
  const topicSlot = topicTab?.shown ? entries.get(chatTabSlotKey(chatId, topicTab.tabId)) : undefined
  return (
    <>
      {panelTabsOf(chatId).filter((tab) => tab.shown).map((tab) => {
        const element = entries.get(chatTabSlotKey(chatId, tab.tabId))
        return element ? createPortal(panel(tab), element, tab.tabId) : null
      })}
      {topicTab && topicSlot ? createPortal(topic(), topicSlot, topicTab.tabId) : null}
    </>
  )
})

/**
 * Where there is no strip (the phone, the assistant's window): the tab in front, a whole page over the chat — its way out
 * is its back. A tab and the 上一页 it goes back to are one page here (`key`: the first of them), so going back finds that
 * page as it was (G2: a phone frame is not kept anywhere else).
 */
export const ChatTabPage = observer(function ChatTabPage({ chatId, panel, topic }: {
  chatId: string
  panel: (tab: ChatPanelTab) => ReactNode
  topic: () => ReactNode
}) {
  const focused = focusedChatTab(chatId)
  if (focused?.kind === 'topic') return <>{topic()}</>
  const tab = focused?.kind === 'panel' ? panelTabOf(chatId, focused.tabId) : null
  if (!tab) return null
  let root = tab.tabId
  for (let back = returnToOf(chatId, root); back && panelTabOf(chatId, back); back = returnToOf(chatId, back)) root = back
  return <Fragment key={root}>{panel(tab)}</Fragment>
})

/** The strip's 「+」 after a chat's tabs: its folder, and the Apps that open here (gugu-dev#181 第 ⑥ 步). */
export function ChatPlusMenu({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const plusRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      <span className="flex h-full shrink-0 items-center px-1">
        <IconButton ref={plusRef} size="sm" aria-label={t('header.openInGroup')} title={t('header.openInGroup')} data-testid="block-panel-plus" on={menuOpen || undefined} onClick={() => setMenuOpen(true)}>
          <Plus />
        </IconButton>
      </span>
      {menuOpen ? (
        <Menu anchor={plusRef} onClose={() => setMenuOpen(false)}>
          <MenuItem icon={<Folder size={16} />} onClick={() => openPanelItem(chatId, folderItem())}>
            <FolderName chatId={chatId} />
          </MenuItem>
          <OpenAppMenuItems chatId={chatId} separated />
        </Menu>
      ) : null}
    </>
  )
}

function FolderName({ chatId }: { chatId: string }) {
  return <>{useChatFolderName(chatId)}</>
}
