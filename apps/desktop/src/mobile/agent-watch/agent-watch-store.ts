import type {
  RecordCursor,
  RecordResetReason,
  Settlement,
  TimelineAfterResult,
  TimelineBatch,
  TimelineOlderResult,
  TimelineSnapshot,
  SessionLiveReply,
  TurnPatch,
} from '@gugu/session-core/session-record/contract'
import type { ToolImage, ToolNode, TranscriptItem, TranscriptTurn } from '@gugu/session-core/acp/client'

/**
 * 手机看管 agent —— 一份会话时间线的纯状态机。
 *
 * 为什么单独一份、且是纯函数:断线补缺口这件事只有在**能被反复喂同一批**的地方才验得动。
 * 组件里做的话,判据只能是「屏幕上看着没重复」;放在这里,判据是
 * `f(f(s, b), b)` 与 `f(s, b)` 相等 —— 一条会红的等式(见 agent-watch-store.test.ts)。
 *
 * 契约见 packages/session-core/src/session-record/contract.ts:
 *   ok:true  → 按**条目**替换(TurnPatch:变过的条目 + 完整的条目 id 顺序)+ 删除 removedTurnIds
 *              + 合并 settlements
 *   ok:false → 整份重载(拿它带来的快照替换全部)
 */
export type AgentWatchTimeline = {
  /** 手里这份读到哪了。null = 还没收到过任何快照。 */
  cursor: RecordCursor | null
  /** 按 seq 升序;同 seq 按 id 稳定排序(seq 本该唯一,并列时不许每次渲染换位置)。 */
  turns: readonly TranscriptTurn[]
  /** itemId → 结算。审批/提问卡片按它决定能不能点。 */
  settlements: Readonly<Record<string, Settlement>>
  /** 快照只取最近若干轮;true = 更早的轮不在手里(如实说,❌ 假装这就是全部)。 */
  hasOlder: boolean
  /** 与桌面聊天浮层共享的时间线动作投影。 */
  recentActions: readonly string[]
  /** 最近一次已知动作的 provider 时间;没有动作时为 null。 */
  lastActionAt: number | null
  /** 已发出、还排着没被 agent 接走的输入:那台机器上的队列,与桌面「Queued prompts」同一份。只读投影。 */
  queuedPrompts: NonNullable<TimelineSnapshot['queuedPrompts']>
  liveReply: SessionLiveReply | null
  /** 最近一次整份重载的原因;null = 没重载过。 */
  lastReset: RecordResetReason | null
  /**
   * 收到了**别的世代**的增量 ⇒ 手里这份接不上它,必须重新拉快照。
   * 这里只记事实,拉快照由页面做 —— reducer 不发请求。
   */
  needsSnapshot: RecordResetReason | null
}

export function emptyAgentWatchTimeline(): AgentWatchTimeline {
  return {
    cursor: null,
    turns: [],
    settlements: {},
    hasOlder: false,
    recentActions: [],
    lastActionAt: null,
    queuedPrompts: [],
    liveReply: null,
    lastReset: null,
    needsSnapshot: null,
  }
}

function sortTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  return turns.sort((a, b) => (a.seq - b.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function indexSettlements(settlements: readonly Settlement[]): Record<string, Settlement> {
  const next: Record<string, Settlement> = {}
  for (const settlement of settlements) next[settlement.itemId] = settlement
  return next
}

/**
 * 合并结算。
 *
 * ⚠️ 已了结的**不会**被晚到/重放的 pending 重新打开:否则那张卡又变成可点 ——
 * 一个按下去必被拒的按钮,正是本仓禁止的假控件。这条同时也是「同一批应用两次结果相同」的一部分。
 *
 * 唯一例外是 `reopen`:**游标往前走的那一批**是宿主此刻的真值。宿主只在一种情况下把已答放回待答 ——
 * 抢到了、投递却失败(`releaseSettlement`)—— 这时不收,卡上就一直写着「已在手机端回答」,
 * 而其实什么都没答上(#6739)。重放的旧批与 RPC 带回的那条仍受上面那道保护。
 */
function mergeSettlements(
  current: Readonly<Record<string, Settlement>>,
  incoming: readonly Settlement[],
  reopen = false,
): Record<string, Settlement> {
  const next: Record<string, Settlement> = { ...current }
  for (const settlement of incoming) {
    const existing = next[settlement.itemId]
    if (!reopen && existing && existing.state !== 'pending' && settlement.state === 'pending') continue
    next[settlement.itemId] = settlement
  }
  return next
}

function isToolNode(item: TranscriptItem): item is ToolNode {
  return item.kind !== 'message' && item.kind !== 'thinking'
}

type ImageRefs = readonly { mimeType: string; chars: number }[] | undefined

function sameRefs(a: ImageRefs, b: ImageRefs): boolean {
  return !!a && !!b && a.length > 0 && a.length === b.length && a.every((ref, i) => ref.mimeType === b[i].mimeType && ref.chars === b[i].chars)
}

/**
 * 宿主重发一条条目时,把手机取回来写进去的图(`withToolImage`)带到新来的那一份上。
 *
 * 发给手机的条目里图只有 `imageRefs`(transport-trim)。宿主重发一条条目时整条替换(这条或它父节点的 JSON 变了就重发:
 * 读图那一组每多读一张、子代理下的调用一变、换代后的整份快照),取到的图就被冲掉了:格子又空着、要再取、流量再花一遍。
 * 只带**同一组图**:新来的只有 refs 没有图,两边 refs 张数、每张类型和字数都一样。按 id 认,不管它挂在哪 ——
 * 连读第二张时第一张从顶层挪进新建的那一组,也认得出。
 * 没东西可带时原样返回同一个引用(推送路径上每条都过它)。
 */
function keepFetchedImages(next: TranscriptItem, fetched: ReadonlyMap<string, ToolNode>): TranscriptItem {
  if (fetched.size === 0 || !isToolNode(next)) return next
  let out: ToolNode = next
  const held = fetched.get(next.id)
  if (held && held.kind !== 'tool-group' && next.kind !== 'tool-group' && !next.images && sameRefs(next.imageRefs, held.imageRefs)) {
    out = { ...next, images: held.images } as ToolNode
  }
  if (next.children?.length) {
    const children = next.children.map((child) => keepFetchedImages(child, fetched) as ToolNode)
    if (children.some((child, i) => child !== next.children?.[i])) out = { ...out, children } as ToolNode
  }
  return out
}

/** 手里带着取到的图的工具条目(工具组里的子调用也算),按 id。 */
function fetchedImagesById(items: readonly TranscriptItem[], into = new Map<string, ToolNode>()): Map<string, ToolNode> {
  for (const item of items) {
    if (!isToolNode(item)) continue
    if (item.kind !== 'tool-group' && item.images?.length) into.set(item.id, item)
    if (item.children) fetchedImagesById(item.children, into)
  }
  return into
}

/** 整份替换。reset 传原因时同时记进 lastReset 并清掉 needsSnapshot。取到的工具图照样带过去(`keepFetchedImages`)。 */
export function applySnapshot(
  state: AgentWatchTimeline,
  snapshot: TimelineSnapshot,
  reset: RecordResetReason | null = null,
): AgentWatchTimeline {
  const fetched = fetchedImagesById(state.turns.flatMap((turn) => turn.items))
  const turns = snapshot.turns.map((turn) => {
    const items = turn.items.map((item) => keepFetchedImages(item, fetched))
    return items.some((item, i) => item !== turn.items[i]) ? { ...turn, items } : turn
  })
  return {
    cursor: snapshot.cursor,
    turns: sortTurns(turns),
    settlements: indexSettlements(snapshot.settlements),
    hasOlder: snapshot.hasOlder,
    recentActions: snapshot.recentActions ?? [],
    lastActionAt: snapshot.lastActionAt ?? null,
    queuedPrompts: snapshot.queuedPrompts ?? [],
    liveReply: snapshot.liveReply ?? null,
    lastReset: reset ?? state.lastReset,
    needsSnapshot: null,
  }
}

/**
 * 往前翻出来的更早那批，前插进手里这份。
 *
 * 世代对不上就**整批丢掉并要求重拉快照** —— 翻页途中宿主换过代（记录被分叉、整份重读），
 * 这一批与手里那份不是同一条时间线，前插进去正是 spec 禁的「少了中间的那一份」。
 */
export function prependOlder(
  state: AgentWatchTimeline,
  older: TimelineOlderResult,
): AgentWatchTimeline {
  if (state.cursor && state.cursor.epoch !== older.epoch) {
    return { ...state, needsSnapshot: 'epoch_changed' }
  }
  const byId = new Map<string, TranscriptTurn>()
  for (const turn of older.turns) byId.set(turn.id, turn)
  for (const turn of state.turns) byId.set(turn.id, turn)
  return {
    ...state,
    turns: sortTurns([...byId.values()]),
    hasOlder: older.hasOlder,
  }
}

/**
 * 把一条增量里的一轮并进手里那一轮:id 在 patch.items 里的取新的(取到的工具图照样带过去,`keepFetchedImages`),
 * 不在的沿用手里的。手里也没有 ⇒ 返回 null(中间丢过一批,交给调用方按缺口处理)。
 */
function mergeTurnPatch(existing: TranscriptTurn | undefined, patch: TurnPatch): TranscriptTurn | null {
  const byId = new Map<string, TranscriptItem>()
  for (const item of existing?.items ?? []) byId.set(item.id, item)
  const fetched = fetchedImagesById(existing?.items ?? [])
  for (const item of patch.items) byId.set(item.id, keepFetchedImages(item, fetched))
  const items: TranscriptItem[] = []
  for (const id of patch.itemIds) {
    const item = byId.get(id)
    if (!item) return null
    items.push(item)
  }
  const { itemIds: _ids, items: _items, ...meta } = patch
  return { ...meta, items }
}

/**
 * 应用一批增量。
 *
 * 每轮带的是变过的条目 + 完整的条目顺序 ⇒ 按条目 id 替换,所以同一批应用两次结果一样。
 * cursor 只前进不后退:重放一批旧的不该把游标拨回去(拨回去 = 下次重连从更早的地方补,
 * 补出来的又是同一批,自己把自己送进循环)。
 */
export function applyBatch(state: AgentWatchTimeline, batch: TimelineBatch): AgentWatchTimeline {
  if (state.cursor && state.cursor.epoch !== batch.cursor.epoch) {
    // 世代变了:手里这份与它不是同一条时间线,拼起来就是「少了中间的那一份」。
    return { ...state, needsSnapshot: 'epoch_changed' }
  }

  // 断层:这一批声明自己从 `from` 接上,而手里的游标还没走到那儿 ⇒ 中间有一批没到。
  // 推送是「发出去不管有没有到」的广播,丢批不会报错,只会安静地少一段。
  // ❌ 不许合并 —— 合并出来的正是 spec 明令禁止的「少了中间的那一份」。
  // `from < 游标` 是重放旧批,无害(按条目替换 + 游标只前进),照常合并。
  if (state.cursor && batch.from > state.cursor.seq) {
    return { ...state, needsSnapshot: 'gap' }
  }

  const byId = new Map<string, TranscriptTurn>()
  for (const turn of state.turns) byId.set(turn.id, turn)
  for (const removedId of batch.removedTurnIds) byId.delete(removedId)
  const oldestSeq = state.turns[0]?.seq
  for (const patch of batch.turns) {
    const merged = mergeTurnPatch(byId.get(patch.id), patch)
    if (merged) {
      byId.set(patch.id, merged)
      continue
    }
    // 这一轮在快照窗口之前(更早的还没翻出来):它的变化与手里这份无关,跳过。
    if (!byId.has(patch.id) && state.hasOlder && oldestSeq !== undefined && patch.seq < oldestSeq) continue
    // 手里既没有这一轮、这批又不完整 ⇒ 中间丢过一批。
    return { ...state, needsSnapshot: 'gap' }
  }

  const cursor = state.cursor && state.cursor.seq > batch.cursor.seq ? state.cursor : batch.cursor
  // 队列每批都带全集:只认不比手里旧的那一批,❌ 让重放的旧批把已经被接走的那句又排回去。
  const current = !state.cursor || batch.cursor.seq >= state.cursor.seq

  return {
    cursor,
    turns: sortTurns([...byId.values()]),
    settlements: mergeSettlements(state.settlements, batch.settlements, !state.cursor || batch.cursor.seq > state.cursor.seq),
    hasOlder: state.hasOlder,
    recentActions: batch.recentActions !== undefined ? batch.recentActions : state.recentActions,
    lastActionAt: batch.lastActionAt !== undefined ? batch.lastActionAt : state.lastActionAt,
    queuedPrompts: batch.queuedPrompts !== undefined && current ? batch.queuedPrompts : state.queuedPrompts,
    liveReply: current && batch.liveReply !== undefined ? batch.liveReply : state.liveReply,
    // 一条正常增量到了 = 重载后的那份已经接上了,「时间线已整份重载」的横幅到此为止。
    // 以前这里原样保留 ⇒ 横幅一旦出现就挂到离开这一页(#3566 审计)。
    lastReset: null,
    needsSnapshot: null,
  }
}

/** 订阅推来的一条结果;`after` 补缺口的返回值也走这里 —— 两条路同一套语义。 */
export function applyTimelineResult(
  state: AgentWatchTimeline,
  result: TimelineAfterResult,
): AgentWatchTimeline {
  return result.ok
    ? applyBatch(state, result.batch)
    : applySnapshot(state, result.snapshot, result.reset)
}

/** 把宿主答复里那条权威结算并进来(respond 返回 already_resolved 时也走这条)。 */
export function applyLocalSettlement(
  state: AgentWatchTimeline,
  settlement: Settlement,
): AgentWatchTimeline {
  return { ...state, settlements: mergeSettlements(state.settlements, [settlement]) }
}

/**
 * 手机去机器上取到的一张工具图,写回手里那条条目的 `images`(发来的那份里只有 `imageRefs`,transport-trim):
 * 就当它本来就带着图 —— 内存里这份时间线、本地留存(timeline-cache)都跟着它走,重开不重取;宿主重发这条时由
 * `keepFetchedImages` 带过去。
 * 只换那一轮那一条(工具组里的子调用也认);条目已经不在了就原样返回。
 */
export function withToolImage(state: AgentWatchTimeline, itemId: string, index: number, image: ToolImage): AgentWatchTimeline {
  const put = (node: ToolNode): ToolNode => {
    if (node.id === itemId && node.kind !== 'tool-group') {
      const images = [...(node.images ?? [])]
      images[index] = image
      return { ...node, images } as ToolNode
    }
    const children = node.children?.map(put)
    return children && children.some((child, i) => child !== node.children?.[i]) ? ({ ...node, children } as ToolNode) : node
  }
  let changed = false
  const turns = state.turns.map((turn) => {
    const items = turn.items.map((item) => (isToolNode(item) ? put(item) : item))
    if (items.every((item, i) => item === turn.items[i])) return turn
    changed = true
    return { ...turn, items: items as TranscriptItem[] }
  })
  return changed ? { ...state, turns } : state
}

export function pendingSettlements(state: AgentWatchTimeline): Settlement[] {
  return Object.values(state.settlements).filter((settlement) => settlement.state === 'pending')
}

/**
 * 钉在时间线末尾(最后一条消息之后、在流里跟着滚)的:**还等着人答、流里又没有它那一行的**。
 * (❌ 钉进贴底的输入框带:那一带没有高度上限,一张比视口高的提问卡会把整个视口盖住 —— 见 ThreadTailExtras。)
 *
 * 一个看不见的待审批 = 卡死的会话,所以它总得有个地方。流里有那一行的(问用户的那次工具调用)卡就画在那一行上,
 * 后面的消息排在它下面;没有那一行的才钉在这里:ACP 审批(按随机 requestId 记,对不上任何工具调用)、
 * 宿主替 agent 问的(D-31)、问出它的那一轮还没翻出来的。
 *
 * 有了结局就不钉。❌ 按「这次打开期间见过它在等」留一张回执钉在末尾:那份记忆只在内存里,刷新就空了 ——
 * 活着时卡压在每条新消息下面,刷新后卡又没了,只剩那条回答消息(owner 10-12 真机)。结局在流里那张卡上看。
 */
export function pinnedSettlements(
  settlements: Readonly<Record<string, Settlement>>,
  /** 已经画在流里的那些卡(按 provider toolCallId)。 */
  inlineIds: ReadonlySet<string>,
): Settlement[] {
  return Object.values(settlements).filter((settlement) => settlement.state === 'pending' && !inlineIds.has(settlement.itemId))
}

/**
 * 这条会话现在要不要打扰人。
 *   waiting = 有等着答的审批/提问(「在等你」)
 *   done    = 最后一轮已经结算、且没人在等(「做完了」)
 *   running = 最后一轮还没结算
 *   idle    = 一轮都没有
 * 只读时间线本身,不另信一个会与它矛盾的状态字段。
 */
export type AgentWatchAttention = 'waiting' | 'done' | 'running' | 'idle'

export function deriveAttention(state: AgentWatchTimeline): AgentWatchAttention {
  if (pendingSettlements(state).length > 0) return 'waiting'
  const last = state.turns.at(-1)
  if (!last) return 'idle'
  return last.outcome ? 'done' : 'running'
}
