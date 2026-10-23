import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ChatHistoryWindow } from './chatHistoryWindow'
import { trimToMessageWindow } from './chatMessageWindow'

type Listener = (rows: MessageItem[]) => void

/** The existing message cache owns publication; every mutation reaches its visible surfaces. */
export class ChatWindowCache extends Map<string, MessageItem[]> {
  private readonly histories = new Map<string, { window: ChatHistoryWindow; stop: () => void }>()
  private readonly listeners = new Map<string, Set<Listener>>()
  override set(chatId: string, rows: MessageItem[]): this {
    const history = this.histories.get(chatId)?.window
    if (history) { history.update(rows); return this }
    const recent = trimToMessageWindow(rows)
    super.set(chatId, recent)
    this.publish(chatId, recent)
    return this
  }
  override delete(chatId: string): boolean {
    this.histories.get(chatId)?.window.reset(chatId)
    const deleted = super.delete(chatId)
    if (deleted) this.publish(chatId, [])
    return deleted
  }
  override clear(): void {
    const ids = [...this.keys()]
    for (const [id, { window }] of this.histories) window.reset(id)
    super.clear()
    for (const id of ids) this.publish(id, [])
  }
  getHistory(chatId: string): ChatHistoryWindow | undefined { return this.histories.get(chatId)?.window }
  history(chatId: string): ChatHistoryWindow {
    const existing = this.histories.get(chatId)
    if (existing) return existing.window
    const window = new ChatHistoryWindow()
    window.reset(chatId, this.get(chatId))
    const publish = () => { super.set(chatId, window.getSnapshot().messages); this.publish(chatId, window.getSnapshot().messages) }
    const stop = window.subscribe(publish)
    this.histories.set(chatId, { window, stop })
    super.set(chatId, window.getSnapshot().messages)
    return window
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
      if (listeners.size === 0) {
        this.listeners.delete(chatId)
        const history = this.histories.get(chatId)
        history?.window.invalidate(); history?.stop(); this.histories.delete(chatId)
        const rows = this.get(chatId)
        if (rows) this.set(chatId, trimToMessageWindow(rows))
      }
    }
  }
}
