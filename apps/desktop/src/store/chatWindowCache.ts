import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ChatHistoryWindow, type HistoryWindow } from './chatHistoryWindow'
import { trimToMessageWindow } from './chatMessageWindow'

export type ConversationSnapshot = {
  messageWindow: HistoryWindow
  loading: boolean
  memberReadSeqs: Record<string, number>
  activeThreadRootId: string | null
  threadMessages: MessageItem[]
  loadingThread: boolean
}

type Listener = (rows: MessageItem[]) => void

/** The existing message cache owns publication; every mutation reaches its visible surfaces. */
export class ChatWindowCache extends Map<string, MessageItem[]> {
  private readonly histories = new Map<string, { window: ChatHistoryWindow; stop: () => void; view: ConversationSnapshot }>()
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
  view(chatId: string): ConversationSnapshot {
    this.history(chatId)
    return this.histories.get(chatId)!.view
  }
  patchView(chatId: string, patch: Partial<ConversationSnapshot>): void {
    const entry = this.histories.get(chatId)
    if (!entry) return
    entry.view = { ...entry.view, ...patch }
    this.publish(chatId, entry.window.getSnapshot().messages)
  }
  history(chatId: string): ChatHistoryWindow {
    const existing = this.histories.get(chatId)
    if (existing) return existing.window
    const window = new ChatHistoryWindow()
    window.reset(chatId, this.get(chatId))
    const publish = () => {
      const entry = this.histories.get(chatId)!
      entry.view = { ...entry.view, messageWindow: window.getSnapshot() }
      super.set(chatId, window.getSnapshot().messages)
      this.publish(chatId, window.getSnapshot().messages)
    }
    const stop = window.subscribe(publish)
    this.histories.set(chatId, { window, stop, view: {
      messageWindow: window.getSnapshot(), loading: false, memberReadSeqs: {},
      activeThreadRootId: null, threadMessages: [], loadingThread: false,
    } })
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
