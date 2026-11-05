import { chatOnScreen } from './onScreenChat'

/** A focused chat wins; with no chat focused, keep the usual on-screen search shortcut. */
export function isChatSearchTarget(surface: HTMLElement | null, chatId: string, focused: Element | null = document.activeElement): boolean {
  // A context element that left the page (the search panel's result row, once the panel closed) is no focus at all.
  const element = focused?.isConnected ? focused : null
  const focusedSurface = element?.closest('[data-chat-surface]')
  if (focusedSurface) return focusedSurface === surface
  if (element?.closest('[role="dialog"]')) return false
  const shown = chatOnScreen()
  return !shown || shown === chatId
}
