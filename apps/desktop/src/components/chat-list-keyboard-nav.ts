export type ChatListNavigationDirection = 1 | -1

export type ChatListShortcut =
  | { kind: 'search' }
  | { kind: 'select'; index: number }
  | { kind: 'move'; direction: ChatListNavigationDirection }

type ChatShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
  Partial<Pick<KeyboardEvent, 'isComposing'>>

/** WeChat-style global chat navigation. Plain arrows and digits stay with the focused control. */
export function chatListShortcutFor(event: ChatShortcutEvent): ChatListShortcut | null {
  if (event.isComposing) return null
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null

  if (!event.shiftKey && event.key.toLowerCase() === 'k') return { kind: 'search' }

  if (!event.shiftKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    return { kind: 'move', direction: event.key === 'ArrowDown' ? 1 : -1 }
  }

  if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
    return { kind: 'select', index: Number(event.key) - 1 }
  }

  return null
}

/** Return the next visible chat without wrapping at either end. */
export function nextChatId(
  chatIds: readonly string[],
  currentChatId: string | null,
  direction: ChatListNavigationDirection,
): string | null {
  if (chatIds.length === 0) return null

  const currentIndex = currentChatId ? chatIds.indexOf(currentChatId) : -1
  if (currentIndex === -1) return direction === 1 ? chatIds[0] : chatIds[chatIds.length - 1]

  const nextIndex = currentIndex + direction
  return chatIds[nextIndex] ?? null
}
