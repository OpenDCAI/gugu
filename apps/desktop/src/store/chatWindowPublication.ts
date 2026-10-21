import { useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'

type Listener = (rows: MessageItem[]) => void

/** The existing message cache owns publication; every mutation reaches its visible surfaces. */
class ChatWindowCache extends Map<string, MessageItem[]> {
  private readonly listeners = new Map<string, Set<Listener>>()
  override set(chatId: string, rows: MessageItem[]): this {
    super.set(chatId, rows)
    this.publish(chatId, rows)
    return this
  }
  override delete(chatId: string): boolean {
    const deleted = super.delete(chatId)
    if (deleted) this.publish(chatId, [])
    return deleted
  }
  override clear(): void {
    const ids = [...this.keys()]
    super.clear()
    for (const id of ids) this.publish(id, [])
  }
  private publish(chatId: string, rows: MessageItem[]): void {
    for (const listener of this.listeners.get(chatId) ?? []) listener(rows)
  }
  readonly subscribe = (chatId: string, listener: Listener): (() => void) => {
    let listeners = this.listeners.get(chatId)
    if (!listeners) this.listeners.set(chatId, listeners = new Set())
    listeners.add(listener)
    listener(this.get(chatId) ?? [])
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(chatId)
    }
  }
}

export function useChatWindowCache() {
  const [cache] = useState(() => new ChatWindowCache())
  return { cache, subscribeChatWindow: cache.subscribe }
}
