import { useEffect, useState } from 'react'
import { UI_EVENTS } from '../../lib/uiEvents'
import { groupSlotMemory } from './groupSlotMemory'

/** The App a chat's panel is asked to open (`GroupAppSlot`): its own page, or else its files in this chat. */
export type AppToOpen = { chatId: string; extensionId: string; tab?: string; request: number; fromChat?: boolean }

/**
 * 「在本群打开」(app-redesign §5): the one way an App is opened from a chat — a card's 「打开」, and the chat header's ⋯
 * (ChatHeaderActions) once the card is gone. Asked with `openApp`, answered by the chat on screen (`useOpenApp`): a group or a private chat —
 * topics use their source chat’s shared panel (主人 10-05:「私聊也是得有面板的」), on the desktop as on the phone.
 */
export function openApp(extensionId: string, chatId?: string): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openApp, { detail: { extensionId, ...(chatId ? { chatId } : {}) } }))
}

/** The chat on screen answers `openApp`: this chat's panel opens with the App (what it returns). */
export function useOpenApp(chatId: string | null, openPanel: () => void): AppToOpen | null {
  const [appToOpen, setAppToOpen] = useState<AppToOpen | null>(null)
  useEffect(() => {
    if (!chatId) return undefined
    // Asked from outside the chat (a banner's or a link's click, MainLayout brought it up): taken now, or when it shows.
    const takeAsked = () => {
      const target = groupSlotMemory.takeApp(chatId)
      if (!target) return
      const fromChat = groupSlotMemory.form(chatId) === 'closed'
      openPanel()
      setAppToOpen({ chatId, ...target, request: Date.now(), ...(fromChat ? { fromChat } : {}) })
    }
    takeAsked()
    window.addEventListener(UI_EVENTS.chatAsked, takeAsked)
    return () => {
      window.removeEventListener(UI_EVENTS.chatAsked, takeAsked)
    }
  }, [chatId, openPanel])
  return appToOpen
}
