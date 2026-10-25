import { chatOnScreen } from './onScreenChat'

/** A focused chat wins; with no chat focused, keep the usual on-screen search shortcut. */
export function isChatSearchTarget(surface: HTMLElement | null, chatId: string, element: Element | null = document.activeElement): boolean {
  const focusedSurface = element?.closest('[data-chat-surface]')
  if (focusedSurface) return focusedSurface === surface
  const shown = chatOnScreen()
  return !shown || shown === chatId
}
