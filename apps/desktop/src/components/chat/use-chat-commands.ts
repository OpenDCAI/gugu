import { createContext, useState, type RefObject } from 'react'
import { useGroupChatSettings } from './useGroupChatSettings'
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider'

export const GroupRenameContext = createContext<{ request: number } | null>(null)

/** Commands reveal the chat's info and its name's editor there; all validation and saving stay there. */
export function useChatCommands({ chatId, isGroup, visible, surface, openSettings }: {
  chatId: string | null; isGroup: boolean; visible: boolean; surface: RefObject<HTMLElement | null>
  openSettings: () => void
}) {
  const { settings } = useGroupChatSettings(isGroup ? chatId : null)
  const [rename, setRename] = useState({ chatId, count: 0 })
  useCommandProvider({
    scopeId: 'session-sub',
    isActive: (element) => visible && !!element && !!surface.current?.contains(element),
    getCommands: () => settings?.can_manage !== true ? [] : [{
      id: 'chat.rename', execute: () => {
        setRename((current) => ({ chatId, count: current.count + 1 }))
        openSettings()
      },
    }],
  })
  return { request: rename.chatId === chatId ? rename.count : 0 }
}
