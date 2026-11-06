import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { ChatHistoryWindow, type HistoryWindow } from './chatHistoryWindow'
import { trimToMessageWindow } from './chatMessageWindow'
import { messageWindow } from '../lib/messageWindows'

export type ConversationSnapshot = {
  messageWindow: HistoryWindow
  loading: boolean
  memberReadSeqs: Record<string, number>
  activeThreadRootId: string | null
  threadMessages: MessageItem[]
  loadingThread: boolean
}
export type ConversationViewport = { chatId?: string | null; owner?: ChatWindowCache; following?: boolean; window?: ChatHistoryWindow; snapshot?: ConversationSnapshot; shared?: ConversationSnapshot }
type Listener = (rows: MessageItem[]) => void
const UNHELD_VIEW: ConversationSnapshot = Object.freeze({
  messageWindow: new ChatHistoryWindow().getSnapshot(), loading: false, memberReadSeqs: {},
  activeThreadRootId: null, threadMessages: [], loadingThread: false,
})

/** Account data and receipts are shared; each presenter owns its history range and navigation. */
export class ChatWindowCache extends Map<string, MessageItem[]> {
  constructor(private readonly accountId: string | null = null) { super() }
  /**
   * @@@resident-rows - when the account's messages live in the local store (desktop), a conversation's rows are held only
   * while a viewport observes it or a read is about to mount one: the last viewport drops them, and writes to a conversation
   * nobody holds are skipped — its rows are read back from the store when a pane opens it again.
   */
  private get residentOnly(): boolean { return this.accountId !== null && messageWindow(this.accountId, '') !== null }
  private readonly histories = new Map<string, { window: ChatHistoryWindow; stop: () => void; stopReading?: () => void; receipts: Set<string>; view: ConversationSnapshot }>()
  private readonly listeners = new Map<string, Map<Listener, ConversationViewport>>()
  override set(chatId: string, rows: MessageItem[]): this {
    const merge = (previous: MessageItem[]) => mergeMessagesById(previous, rows, chatId)
    const history = this.getHistory(chatId)
    if (history) history.update(merge)
    else { super.set(chatId, trimToMessageWindow(merge(this.get(chatId) ?? []))); this.publish(chatId) }
    for (const viewport of this.listeners.get(chatId)?.values() ?? []) viewport.window?.update(merge)
    return this
  }
  update(chatId: string, updater: MessageItem[] | ((previous: MessageItem[]) => MessageItem[])): this {
    if (this.residentOnly && !this.isObserved(chatId) && !super.has(chatId)) return this
    const previous = this.rows(chatId)
    const next = typeof updater === 'function' ? updater(previous) : mergeMessagesById(previous, updater, chatId)
    const retained = new Set(next.map((row) => row.id))
    const before = new Map(previous.map((row) => [row.id, row]))
    const changed = next.filter((row) => before.get(row.id) !== row)
    const apply = (rows: MessageItem[]) => mergeMessagesById(rows.filter((row) => retained.has(row.id)), changed, chatId)
    const history = this.histories.get(chatId)?.window
    if (history) history.update(apply)
    else { super.set(chatId, trimToMessageWindow(next)); this.publish(chatId) }
    for (const viewport of this.listeners.get(chatId)?.values() ?? []) viewport.window?.update(apply)
    return this
  }
  establishTail(chatId: string, rows: MessageItem[]): void {
    this.history(chatId).establishTail(rows)
    for (const viewport of this.listeners.get(chatId)?.values() ?? []) viewport.window?.establishTail(rows)
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
    // Before its first viewport subscribes (or after the last left) a conversation has no shared entry: reading it does not
    // create one (@@@resident-rows). A mounting viewport still gets its own window over the rows read for it.
    if (this.residentOnly && !this.isObserved(chatId) && !this.histories.has(chatId)) {
      if (!viewport) return UNHELD_VIEW
      const window = this.viewportWindow(chatId, viewport)
      if (viewport.shared !== UNHELD_VIEW || viewport.snapshot?.messageWindow !== window.getSnapshot()) {
        viewport.shared = UNHELD_VIEW
        viewport.snapshot = { ...UNHELD_VIEW, messageWindow: window.getSnapshot() }
      }
      return viewport.snapshot!
    }
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
  private viewportWindow(chatId: string, viewport: ConversationViewport): ChatHistoryWindow {
    if (viewport.owner !== this || !viewport.window) {
      viewport.owner = this
      viewport.window = new ChatHistoryWindow(this.accountId)
      viewport.window.reset(chatId, this.get(chatId))
    }
    return viewport.window
  }
  history(chatId: string, viewport?: ConversationViewport): ChatHistoryWindow {
    if (viewport) {
      const window = this.viewportWindow(chatId, viewport)
      this.history(chatId)
      return window
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
    if (following === undefined) return
    if (this.residentOnly && !this.isObserved(chatId)) this.viewportWindow(chatId, viewport).setFollowingTail(following)
    else this.history(chatId, viewport).setFollowingTail(following)
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
        if (this.residentOnly) super.delete(chatId)
        else if (rows) super.set(chatId, trimToMessageWindow(rows))
      }
    }
  }
}
