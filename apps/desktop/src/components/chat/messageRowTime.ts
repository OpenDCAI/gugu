import type { MessageItem } from '@gugu/core/shared/types/chat'

// Five minutes keeps row-level timeline breaks sparse; shorter gaps already have bubble timestamps.
export function shouldShowTimeDivider(messages: MessageItem[], index: number): boolean {
  if (index === 0) return true
  const previous = new Date(messages[index - 1].created_at).getTime()
  const current = new Date(messages[index].created_at).getTime()
  return current - previous >= 5 * 60 * 1000
}
