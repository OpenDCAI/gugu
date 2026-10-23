import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { INITIAL_PAGE, MAX_WINDOW, MESSAGE_WINDOW, OLDER_PAGE, maxMainlineSeq } from './chatMessageWindow'

export const HISTORY_START_INDEX = 100000
type Direction = 'older' | 'newer' | 'latest'
export type HistoryWindow = {
  chatId: string | null
  messages: MessageItem[]
  firstItemIndex: number
  hasOlder: boolean
  hasNewer: boolean
  loading: Direction | 'anchor' | null
  change: Direction | 'anchor' | 'update' | 'reset'
  navigation: Direction | 'anchor' | 'reset'
  navigationVersion: number
  viewVersion: number
  newMessageCount: number
  latestSeen: number
}
export type FetchHistoryPage = (chatId: string, direction: Direction, cursor: number, limit: number) => Promise<MessageItem[]>

/** Keep a retained message at the same absolute virtual index in either direction. */
export function movedWindowIndex(previous: readonly Pick<MessageItem, 'id'>[], next: readonly Pick<MessageItem, 'id'>[], index: number): number {
  const oldIndices = new Map(previous.map((message, position) => [message.id, position]))
  for (let position = 0; position < next.length; position += 1) {
    const oldPosition = oldIndices.get(next[position]!.id)
    if (oldPosition !== undefined) return index + oldPosition - position
  }
  return HISTORY_START_INDEX
}

function oldestSeq(rows: readonly MessageItem[]): number {
  return rows.reduce((oldest, row) => row.seq > 0 ? Math.min(oldest, row.seq) : oldest, Infinity)
}

function sameRows(left: readonly MessageItem[], right: readonly MessageItem[]): boolean {
  return left.length === right.length && left.every((row, index) => row === right[index])
}

/** Pending outbox rows must retain their retry controls when persisted history is cropped. */
function boundRows(rows: MessageItem[], limit: number, edge: 'head' | 'tail' = 'tail'): MessageItem[] {
  const pending = rows.filter((row) => row.seq < 1)
  const settled = rows.filter((row) => row.seq > 0)
  const capacity = Math.max(0, limit - pending.length)
  return [...(capacity === 0 ? [] : edge === 'head' ? settled.slice(0, capacity) : settled.slice(-capacity)), ...pending]
}

// @@@6352 A tail-following window slides; it never shrinks in bulk while the list is mounted. Rejoining
// the tail after reading history used to crop 120 rows to 40 at once: the old virtualized list compensated
// a removal of thousands of pixels above the reader over several frames (blank frames, a transient scrollTop≈0 that
// even requested an older page). New tail rows grow the window up to MAX_WINDOW, then drop one head row
// each (#6530: sliding a burst of k rows keeps the length, so that list never saw an append and its
// follow-output did not fire — the reader stayed ~2000px above the bottom). A reset opens at 40.
function tailBound(rows: readonly MessageItem[]): number {
  return Math.min(MAX_WINDOW, Math.max(MESSAGE_WINDOW, rows.length))
}

/** One committed row set owns its bounds and virtual indices; requests own an activation token. */
export class ChatHistoryWindow {
  constructor(readonly accountId: string | null = null) {}
  private state: HistoryWindow = {
    chatId: null, messages: [], firstItemIndex: HISTORY_START_INDEX, hasOlder: false,
    hasNewer: false, loading: null, change: 'reset', navigation: 'reset', navigationVersion: 0, viewVersion: 0, newMessageCount: 0, latestSeen: 0,
  }
  private generation = 0
  private followingTail = true
  // Retaining only a historical slice must not turn a previously seen tail into new arrivals.
  private latestSeenByChat = new Map<string, number>()
  private listeners = new Set<() => void>()
  readonly messagesRef = { current: this.state.messages }
  getSnapshot = (): HistoryWindow => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: HistoryWindow): void {
    if ((Object.keys(next) as (keyof HistoryWindow)[]).every((key) => this.state[key] === next[key])) return
    this.state = next
    if (next.chatId) this.latestSeenByChat.set(next.chatId, next.latestSeen)
    this.messagesRef.current = next.messages
    for (const listener of this.listeners) listener()
  }

  reset(chatId: string | null, messages: MessageItem[] = []): void {
    this.generation += 1
    this.followingTail = true
    const bounded = boundRows(messages, MESSAGE_WINDOW)
    this.publish({ chatId, messages: bounded, firstItemIndex: HISTORY_START_INDEX,
      hasOlder: oldestSeq(bounded) > 1 && bounded.length > 0, hasNewer: false, loading: null,
      change: 'reset', navigation: 'reset', navigationVersion: this.state.navigationVersion + 1, viewVersion: this.state.viewVersion + 1, newMessageCount: 0,
      latestSeen: Math.max(maxMainlineSeq(messages), chatId ? this.latestSeenByChat.get(chatId) ?? 0 : 0) })
  }

  invalidate = (): void => {
    this.generation += 1
    if (this.state.loading) this.publish({ ...this.state, loading: null })
  }

  setHasOlder = (hasOlder: boolean): void => {
    // Cache/page-fill hints cannot prove exhaustion: seq 1 and an empty older
    // response can. In particular a trimmed cache may carry an old false flag.
    const next = oldestSeq(this.state.messages) === 1 ? false : hasOlder || this.state.hasOlder
    if (this.state.hasOlder !== next) this.publish({ ...this.state, hasOlder: next })
  }

  setFollowingTail = (following: boolean): boolean => {
    this.followingTail = following && !this.state.hasNewer && this.state.loading === null
    if (this.followingTail) {
      this.commit(this.state.messages, { change: 'update', newMessageCount: 0 })
    }
    return this.followingTail
  }

  /**
   * 发送动作把窗口钉回底部(C3)。窗口本就含尾(无 hasNewer)⇒ 立即恢复跟尾并返回 true;
   * 窗口是一段离尾的历史 ⇒ 返回 false,由调用方拉最新页(load('latest') 结束时自己恢复跟尾)。
   */
  followForSend = (): boolean => {
    if (this.state.hasNewer) return false
    const following = this.setFollowingTail(true)
    if (following) this.publish({ ...this.state, navigation: 'latest', navigationVersion: this.state.navigationVersion + 1 })
    return following
  }

  isFollowingTail = (): boolean => this.followingTail && !this.state.hasNewer && this.state.loading === null

  private commit(messages: MessageItem[], fields: Partial<HistoryWindow>): void {
    const previous = this.state
    const rows = sameRows(previous.messages, messages) ? previous.messages : messages
    const firstItemIndex = movedWindowIndex(previous.messages, rows, previous.firstItemIndex)
    const headChanged = oldestSeq(rows) !== oldestSeq(previous.messages)
    this.publish({ ...previous, messages: rows, firstItemIndex,
      hasOlder: oldestSeq(rows) === 1 ? false : headChanged ? rows.length > 0 : previous.hasOlder,
      ...fields })
  }

  /** Revisions/overlays cannot replace a reader's history window with the live tail. */
  update = (updater: MessageItem[] | ((previous: MessageItem[]) => MessageItem[])): void => {
    const previous = this.state
    const incoming = typeof updater === 'function' ? updater(previous.messages) : updater
    const latestSeen = Math.max(previous.latestSeen, maxMainlineSeq(incoming))
    if (this.followingTail && !previous.hasNewer && previous.loading !== 'older') {
      // A late heal can contain an old page disconnected from the established
      // range. Only explicit older navigation is allowed to extend its old end.
      const lower = oldestSeq(previous.messages)
      const rows = Number.isFinite(lower) ? incoming.filter((row) => row.seq < 1 || row.seq >= lower) : incoming
      this.commit(boundRows(rows, tailBound(rows)), { latestSeen, change: 'update' })
      return
    }
    const upper = maxMainlineSeq(previous.messages)
    const lower = oldestSeq(previous.messages)
    const pending = incoming.filter((row) => row.seq < 1
      && (previous.loading === 'latest' || previous.messages.some((existing) => existing.id === row.id)))
    // C3 — 窗口含尾(无 hasNewer)时,seq 越过上界的行就是尾巴在继续长:接上(按头部封顶,读者看的那段
    // 不动;超出容量才截尾并亮 hasNewer)。从前一律丢弃,自己刚发的消息确认后从屏上消失、新消息「不来」。
    // 窗口是离尾的历史段时不接(会在窗口里留洞,增量游标会跳过洞里的行);唯一例外是正在拉最新页时
    // 自己发的行 —— 它马上并入最新页(load('latest') 保留比页尾更新的行),不该先消失再出现。
    const beyondUpper = (row: MessageItem) =>
      !previous.hasNewer || (previous.loading === 'latest' && row.is_mine)
    const settled = incoming.filter((row) => row.seq >= 1
      && (Number.isFinite(lower) ? row.seq >= lower : true)
      && (row.seq <= upper || beyondUpper(row)))
    const messages = boundRows([...settled, ...pending], MAX_WINDOW, 'head')
    const received = incoming.filter((row) => row.seq > previous.latestSeen && !row.is_mine).length
    this.commit(messages, { latestSeen, change: 'update', hasNewer: previous.hasNewer || latestSeen > maxMainlineSeq(messages),
      newMessageCount: previous.newMessageCount + received })
  }

  /** A full cold-start delta cannot be joined to a disconnected cached range. */
  establishTail = (messages: MessageItem[]): void => {
    if (maxMainlineSeq(messages) < maxMainlineSeq(this.state.messages)) {
      this.update(mergeMessagesById(this.state.messages, messages, this.state.chatId!))
      return
    }
    if (this.followingTail && !this.state.hasNewer && !this.state.loading) {
      const arrivedAfterSnapshot = this.state.messages.filter((row) => row.seq < 1 || row.seq > maxMainlineSeq(messages))
      const retained = oldestSeq(messages) <= maxMainlineSeq(this.state.messages) + 1 ? this.state.messages : []
      const next = mergeMessagesById(retained, [...messages, ...arrivedAfterSnapshot], this.state.chatId!)
      const hasNewer = this.state.latestSeen > maxMainlineSeq(next)
      this.followingTail = !hasNewer
      this.commit(boundRows(next, tailBound(this.state.messages)), { hasNewer, latestSeen: Math.max(this.state.latestSeen, maxMainlineSeq(next)), change: 'update' })
    } else {
      this.commit(this.state.messages, { hasNewer: this.state.hasNewer || maxMainlineSeq(messages) > maxMainlineSeq(this.state.messages) })
      this.update(mergeMessagesById(this.state.messages, messages, this.state.chatId!))
    }
  }

  async restoreAnchor(fetchWindow: (chatId: string) => Promise<{ messages: MessageItem[]; hasNewer: boolean }>): Promise<boolean> {
    const chatId = this.state.chatId
    if (!chatId) return false
    this.invalidate()
    const generation = this.generation
    const current = () => generation === this.generation && chatId === this.state.chatId
    this.followingTail = false
    this.publish({ ...this.state, loading: 'anchor' })
    try {
      const result = await fetchWindow(chatId)
      if (!current()) return false
      const live = this.state
      const retained = mergeMessagesById(result.messages, live.messages.filter((row) => row.seq < 1), chatId)
      this.commit(boundRows(retained, MAX_WINDOW), { loading: null, change: 'anchor', navigation: 'anchor', navigationVersion: live.navigationVersion + 1, viewVersion: live.viewVersion + 1,
        hasNewer: result.hasNewer || live.latestSeen > maxMainlineSeq(result.messages), latestSeen: Math.max(live.latestSeen, maxMainlineSeq(result.messages)) })
      return true
    } catch (error) {
      if (!current()) return false
      this.publish({ ...this.state, loading: null })
      throw error
    }
  }

  async load(direction: Direction, fetchPage: FetchHistoryPage): Promise<boolean> {
    if (!this.state.chatId) return false
    if (direction === 'latest') this.invalidate()
    else if (this.state.loading || (direction === 'newer' && !this.state.hasNewer)) return false
    const before = this.state
    const cold = !before.messages.some((row) => row.seq > 0)
    if (direction === 'older' && (!before.hasOlder || oldestSeq(before.messages) === 1)) return false
    const cursor = direction === 'older' ? oldestSeq(before.messages) : maxMainlineSeq(before.messages)
    if (direction !== 'latest' && (!Number.isFinite(cursor) || cursor < 1)) return false
    const generation = this.generation
    const chatId = before.chatId!
    // 往旧翻只长头部,不改变读者是否钉在底部(短会话里顶和底同屏);往新 / 回最新会移动尾部,先解钉。
    if (direction !== 'older') this.followingTail = false
    this.publish({ ...before, loading: direction })
    const current = () => generation === this.generation && chatId === this.state.chatId
    try {
      let page = await fetchPage(chatId, direction, cursor, direction === 'latest' ? INITIAL_PAGE : OLDER_PAGE)
      if (!current()) return false
      // C3 — 拉取在途时尾巴又长了(比如自己刚发的消息确认了):这一页读的是旧尾,再读一次最新页。
      // 从前直接收下旧页并亮 hasNewer,「回到最新」之后仍不在最新、也不跟尾。
      if (direction === 'latest' && !cold && this.state.latestSeen > maxMainlineSeq(page)) {
        page = await fetchPage(chatId, direction, cursor, INITIAL_PAGE)
        if (!current()) return false
      }
      const live = this.state
      if (direction === 'latest') {
        // 保留乐观行与比页尾更新的确认行;冷首读还保留在途到达的对端行。
        const pageTail = maxMainlineSeq(page)
        const pending = live.messages.filter((row) => row.seq < 1 || (pageTail > 0 && (row.is_mine || cold) && row.seq > pageTail))
        const messages = boundRows(mergeMessagesById(page, pending, chatId), MESSAGE_WINDOW)
        const hasNewer = live.latestSeen > maxMainlineSeq(messages)
        this.followingTail = !hasNewer
        this.commit(messages, { change: direction, navigation: direction, navigationVersion: live.navigationVersion + 1, viewVersion: live.viewVersion + 1, loading: null, hasOlder: page.length > 0 && oldestSeq(page) > 1,
          hasNewer, latestSeen: Math.max(live.latestSeen, maxMainlineSeq(page)), newMessageCount: hasNewer ? live.newMessageCount : 0 })
      } else if (page.length === 0) {
        this.publish({ ...live, change: direction, navigation: direction, navigationVersion: live.navigationVersion + 1, loading: null,
          ...(direction === 'older' ? { hasOlder: false } : { hasNewer: live.latestSeen > before.latestSeen }) })
      } else {
        const merged = mergeMessagesById(live.messages, page, chatId)
        const messages = boundRows(merged, MAX_WINDOW, direction === 'older' ? 'head' : 'tail')
        const hasNewer = direction === 'older'
          ? live.hasNewer || maxMainlineSeq(merged) > maxMainlineSeq(messages)
          : page.length >= OLDER_PAGE || live.latestSeen > maxMainlineSeq(messages)
        this.commit(messages, { change: direction, navigation: direction, navigationVersion: live.navigationVersion + 1, loading: null, hasNewer,
          ...(direction === 'older' ? { hasOlder: oldestSeq(page) > 1 } : {}),
          latestSeen: Math.max(live.latestSeen, maxMainlineSeq(page)) })
      }
      return true
    } catch (error) {
      if (!current()) return false
      this.publish({ ...this.state, loading: null })
      throw error
    }
  }
}
