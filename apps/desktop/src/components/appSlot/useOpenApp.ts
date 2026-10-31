import { UI_EVENTS } from '../../lib/uiEvents'

/**
 * 「在本群打开」(app-redesign §5): the one way an App is opened from a chat — a card's 「打开」, the chat header's pins and its
 * 群 Apps, the ⋯ (ChatHeaderActions) and the panel's 「+」. Asked with `openApp`, MainLayout brings the chat up and asks its
 * chat (`askChat`), answered by the chat on screen (`useChatOpener`): a group or a private chat — topics use their
 * source chat's shared panel (主人 10-05:「私聊也是得有面板的」), on the desktop as on the phone.
 */
export function openApp(extensionId: string, chatId?: string): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openApp, { detail: { extensionId, ...(chatId ? { chatId } : {}) } }))
}
