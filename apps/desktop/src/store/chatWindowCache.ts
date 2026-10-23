import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
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
export type ConversationViewport = { owner?: ChatWindowCache; following?: boolean; window?: ChatHistoryWindow; snapshot?: ConversationSnapshot; shared?: ConversationSnapshot }
type Listener = (rows: MessageItem[]) => void

/** Account data and receipts are shared; each presenter owns its history range and navigation. */
export class ChatWindowCache extends Map<string, MessageItem[]> {
  constructor(private readonly accountId: string | null = null) { super() }
  private readonly histories = new Map<string, { window: ChatHistoryWindow; stop: () => void; stopReading?: () => void; receipts: Set<string>; view: ConversationSnapshot }>()
  private readonly listeners = new Map<string, Map<Listener, ConversationViewport>>()
  override set(chatId: string, rows: MessageItem[]): this {
    return this.update(chatId, (previous) => mergeMessagesById(previous, rows, chatId))
  }
  update(chatId: string, updater: MessageItem[] | ((previous: MessageItem[]) => MessageItem[])): this {
    const apply = typeof updater === 'function' ? updater : (previous: MessageItem[]) => mergeMessagesById(previous, updater, chatId)
    const history = this.histories.get(chatId)?.window
    if (history) history.update(apply)
    else { super.set(chatId, trimToMessageWindow(apply(this.get(chatId) ?? []))); this.publish(chatId) }
    for (const viewport of this.listeners.get(chatId)?.values() ?? []) viewport.window?.update(apply)
    return this
  }
  override delete(chatId: string): boolean {
    this.getHistory(chatId)?.reset(chatId)
    for (const viewport of this.listeners.get(chatId)?.values() ?? []) viewport.window?.reset(chatId)
    this.patchView(chatId, { activeThreadRootId: null, threadMessages: [], loadingThread: false, memberReadSeqs: {} })
    const deleted = super.delete(chatId)
    if (deleted) this.publish(chatId)
    return deleted
  }
  override clear(): void {
    for (const id of [...this.keys()]) this.delete(id)
    super.clear()
  }
  isObserved(chatId: string): boolean { return (this.listeners.get(chatId)?.size ?? 0) > 0 }
  isFollowingTail(chatId: string): boolean { return [...this.listeners.get(chatId)?.values() ?? []].some((viewport) => viewport.following === true && viewport.window?.isFollowingTail()) }
  rows(chatId: string): MessageItem[] {
    let rows = this.get(chatId) ?? []
    for (const viewport of this.listeners.get(chatId)?.values() ?? []) rows = mergeMessagesById(viewport.window?.getSnapshot().messages ?? [], rows, chatId)
    return rows
  }
  readReceipts(chatId: string): Set<string> { return this.histories.get(chatId)!.receipts }
  getHistory(chatId: string): ChatHistoryWindow | undefined { return this.histories.get(chatId)?.window }
  view(chatId: string, viewport?: ConversationViewport): ConversationSnapshot {
    const window = this.history(chatId, viewport), shared = this.histories.get(chatId)!.view
    if (!viewport) return shared
    if (viewport.shared !== shared || viewport.snapshot?.messageWindow !== window.getSnapshot()) {
      viewport.shared = shared
      viewport.snapshot = { ...shared, messageWindow: window.getSnapshot() }
    }
    return viewport.snapshot!
  }
  patchView(chatId: string, patch: Partial<ConversationSnapshot>): void {
    const entry = this.histories.get(chatId)
    if (!entry || Object.entries(patch).every(([key, value]) => Object.is(entry.view[key as keyof ConversationSnapshot], value))) return
    entry.view = { ...entry.view, ...patch }
    this.publish(chatId)
  }
  history(chatId: string, viewport?: ConversationViewport): ChatHistoryWindow {
    if (viewport) {
      if (viewport.owner !== this || !viewport.window) {
        viewport.owner = this
        viewport.window = new ChatHistoryWindow(this.accountId)
        viewport.window.reset(chatId, this.get(chatId))
      }
      this.history(chatId)
      return viewport.window
    }
    const existing = this.histories.get(chatId)
    if (existing) return existing.window
    const window = new ChatHistoryWindow(this.accountId)
    window.reset(chatId, this.get(chatId))
    const stop = window.subscribe(() => {
      const entry = this.histories.get(chatId)!
      entry.view = { ...entry.view, messageWindow: window.getSnapshot() }
      super.set(chatId, window.getSnapshot().messages)
      this.publish(chatId)
    })
    this.histories.set(chatId, { window, stop, receipts: new Set(), view: {
      messageWindow: window.getSnapshot(), loading: window.getSnapshot().messages.length === 0, memberReadSeqs: {},
      activeThreadRootId: null, threadMessages: [], loadingThread: false,
    } })
    super.set(chatId, window.getSnapshot().messages)
    return window
  }
  private publish(chatId: string): void {
    for (const listener of this.listeners.get(chatId)?.keys() ?? []) listener(this.get(chatId) ?? [])
  }
  readonly setFollowingTail = (chatId: string, viewport: ConversationViewport, following: boolean | undefined): void => {
    viewport.following = following
    if (following !== undefined) this.history(chatId, viewport).setFollowingTail(following)
  }
  readonly subscribe = (chatId: string, listener: Listener, start?: () => () => void, viewport: ConversationViewport = {}): (() => void) => {
    let listeners = this.listeners.get(chatId)
    if (!listeners) this.listeners.set(chatId, listeners = new Map())
    const first = listeners.size === 0
    const window = this.history(chatId, viewport)
    listeners.set(listener, viewport)
    const stopWindow = window.subscribe(() => listener(window.getSnapshot().messages))
    if (first && start) this.histories.get(chatId)!.stopReading = start()
    listener(window.getSnapshot().messages)
    return () => {
      stopWindow(); window.invalidate(); listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(chatId)
        const history = this.histories.get(chatId)
        history?.stopReading?.(); history?.window.invalidate(); history?.stop(); this.histories.delete(chatId)
        const rows = this.get(chatId)
        if (rows) super.set(chatId, trimToMessageWindow(rows))
      }
    }
  }
}
