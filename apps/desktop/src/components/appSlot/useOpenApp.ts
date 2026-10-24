import { useEffect, useState } from 'react'
import { UI_EVENTS } from '../../lib/uiEvents'
import { groupSlotMemory, type OpenRequest } from './groupSlotMemory'

/**
 * 「在本群打开」(app-redesign §5): the one way an App is opened from a chat — a card's 「打开」, the chat header's pins and its
 * 群 Apps, the ⋯ (ChatHeaderActions) and the panel's 「+」. Asked with `openApp`, MainLayout brings the chat up and asks its
 * panel (`groupSlotMemory.ask`), answered by the chat on screen (`useOpenApp`): a group or a private chat — topics use their
 * source chat's shared panel (主人 10-05:「私聊也是得有面板的」), on the desktop as on the phone.
 */
export function openApp(extensionId: string, chatId?: string): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openApp, { detail: { extensionId, ...(chatId ? { chatId } : {}) } }))
}

/**
 * The chat on screen answers what was asked of its panel, every way in (`groupSlotMemory.ask`: an App, a link's file, a
 * page's `files.openWith`): taken now, or as soon as this chat is the one shown; its panel comes up with it (what it
 * returns). A page in the panel asked: the tab it was is the 上一页 of what it opens (owner 10-24).
 */
export function useOpenApp(chatId: string | null, openPanel: () => void): OpenRequest | null {
  const [asked, setAsked] = useState<OpenRequest | null>(null)
  useEffect(() => {
    if (!chatId) return undefined
    const take = () => {
      const what = groupSlotMemory.take(chatId)
      if (!what) return
      const from = groupSlotMemory.form(chatId) !== 'closed' && 'fromPage' in what ? groupSlotMemory.opened(chatId) : null
      openPanel()
      setAsked({ ...what, chatId, request: Date.now(), ...(from ? { from } : {}) })
    }
    take()
    window.addEventListener(UI_EVENTS.chatAsked, take)
    return () => window.removeEventListener(UI_EVENTS.chatAsked, take)
  }, [chatId, openPanel])
  return asked
}
