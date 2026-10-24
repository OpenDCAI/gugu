import { createContext, useEffect, useState, type RefObject } from 'react'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'
import { UI_EVENTS, type ChatDetailsRequest } from '@/lib/uiEvents'

export const GroupRenameContext = createContext<{ request: number; edit: () => void } | null>(null)

/** Commands reveal the existing drawer/editor; all validation and saving stay there. */
export function useChatCommands({ chatId, canRename, visible, surface, openSettings, openAnnouncement }: {
  chatId: string | null; canRename: boolean; visible: boolean; surface: RefObject<HTMLElement | null>
  openSettings: () => void; openAnnouncement: () => void
}) {
  const [rename, setRename] = useState({ chatId, count: 0 })
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => visible && !!element && !!surface.current?.contains(element),
    getCommands: () => !canRename ? [] : [{
      id: 'chat.rename', execute: () => {
        setRename((current) => ({ chatId, count: current.count + 1 }))
        openSettings()
      },
    }],
  })
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<ChatDetailsRequest>).detail
      if (!chatId || detail?.chatId !== chatId) return
      if (detail.page === 'announcement') openAnnouncement()
      else openSettings()
    }
    window.addEventListener(UI_EVENTS.openChatDetailsDrawer, open)
    return () => window.removeEventListener(UI_EVENTS.openChatDetailsDrawer, open)
  }, [chatId, openAnnouncement, openSettings])
  return { request: rename.chatId === chatId ? rename.count : 0, edit: () => { commandRegistry.dispatch('chat.rename') } }
}
