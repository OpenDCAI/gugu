import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { LayoutGrid } from '@/lib/icons'
import { IconButton } from '../ui/IconButton'
import { useChatFolderName } from '../chat/chatFolderName'
import { UI_EVENTS } from '../../lib/uiEvents'
import { GroupFolderSlot } from './GroupFolderSlot'
import { groupSlotMemory, type FileToOpen } from './groupSlotMemory'
import { useOpenApp } from './useOpenApp'

const VIEW_STYLE: CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }

/**
 * A topic's own workspace (摩擦单 F23): a topic is a chat, so it has one — the same workspace App in the
 * same slot as a group's, bound to the topic's chatId (its files, not the group's). The topic pane
 * mounts the toggle in its header and the view in its body; nothing else about it lives there.
 */
export function useTopicWorkspace(
  chatId: string,
  mobile: boolean,
  /** Opening it closes the pane's other views (attachments, members). */
  closeOthers: () => void,
): { open: boolean; show: () => void; close: () => void; folderName: string; toggle: ReactNode; view: ReactNode } {
  const folderName = useChatFolderName(chatId)
  const [openFor, setOpenFor] = useState<string | null>(null)
  const open = openFor === chatId
  const close = useCallback(() => setOpenFor(null), [])
  // A file of this topic asked for by a link (摩擦单 F10, MainLayout brought the topic up): its own workspace opens on
  // it, here — now, or as soon as this split shows the topic.
  const [fileToOpen, setFileToOpen] = useState<FileToOpen | null>(null)
  const closeOthersRef = useRef(closeOthers)
  closeOthersRef.current = closeOthers
  useEffect(() => {
    const takeAskedFile = () => {
      const asked = groupSlotMemory.takeFile(chatId)
      if (!asked) return
      closeOthersRef.current()
      setOpenFor(chatId)
      setFileToOpen({ chatId, ...asked, request: Date.now() })
    }
    takeAskedFile()
    window.addEventListener(UI_EVENTS.chatAsked, takeAskedFile)
    return () => window.removeEventListener(UI_EVENTS.chatAsked, takeAskedFile)
  }, [chatId])
  // 「在本群打开」 from this topic (a card in it): its own panel opens with the App — the topic beside the group is not
  // the chat on screen, so this pane answers for it.
  const openPanel = useCallback(() => {
    closeOthersRef.current()
    setOpenFor(chatId)
  }, [chatId])
  const appToOpen = useOpenApp(chatId, openPanel)
  const toggle = (
    <IconButton
      size={mobile ? 'md' : 'sm'}
      data-testid="topic-split-workspace-toggle"
      on={open || undefined}
      aria-pressed={open}
      aria-label={folderName}
      title={folderName}
      onClick={() => {
        if (!open) closeOthers()
        setOpenFor(open ? null : chatId)
      }}
    >
      <LayoutGrid size={16} />
    </IconButton>
  )
  const view = open ? (
    <div style={VIEW_STYLE} data-testid="topic-split-workspace">
      <GroupFolderSlot chatId={chatId} onClose={close} appToOpen={appToOpen} fileToOpen={fileToOpen} />
    </div>
  ) : null
  // `show`: the phone's ⋯ opens it instead of the toggle (TopicMoreMenu), under the same name.
  return { open, show: openPanel, close, folderName, toggle, view }
}
