import { recordPresenceBatch } from './perfCounters'
// 渲染层**唯一**的那张 agent 状态表:键是 agentId,值是「关于这个 agent 我观测到什么」。
// 会话列表、标题栏、头像、群成员、群汇总、会话里的运行条、composer 忙态 —— 全部读它,读法只有一种。
// ❌ 这里没有「按会话」的任何一维:一个 agent 在不在干活是它自己的事实,不是某条会话的属性
// (那一维正是 owner 2026-09-11 报的「群里工作中、单聊空闲」的来源)。
//
// 一个 agent 的状态有三根互相独立的轴(spec agent-status-vocabulary):
//   · 可达 —— 云端那一行(账号 / 设备 / 意图 / runtime),跨设备、可回源
//   · 读数 —— 跑这个 agent 的宿主的状态写入者写下的那一句(基础态 + 附属态)
//   · 未读 —— 看的人自己的
// 读数只有一个写入者,走两条路:这台机器就是它的宿主时读本机流(宿主按 agent 的流,同一个写入者、路更短),
// 否则读云端那一行上的读数(宿主写 presence 时带上的同一句)。❌ 两条路比版本:本机有就是本机的。

import { dataClient } from './supabase'
import {
  parseAgentPresencePayload,
  type AgentPresencePayload,
} from '@gugu/core/cloud/agentPresenceProtocol'
import {
  deriveAgentReachability,
  displayStatusOf,
  readingOfPresenceProjection,
} from '@gugu/core/shared/ui/agentConversationStatusModels'
import {
  presentAgentStatus,
  type AgentStatusPresentation,
} from '@gugu/core/shared/agentStatusPresentation'
import { isDeviceOnline } from '@gugu/core/shared/enums/deviceModels'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import type { AgentStatusReading, AgentStatusView } from '@gugu/core/shared/agentStatus'
import type { ProviderBlocker, ProviderReviewGate } from './sessionpageAgentProjection'

/**
 * 本机宿主按 agent 的流里这个 agent 的那一条(spec agent-status-writer「宿主按 agent 的流」):这台机器就是它的
 * 宿主时才有。读数之外还带着只有宿主知道的两件事:审阅门与 provider 阻塞。
 */
export type LocalAgentStatus = {
  sessionId: string
  reading: AgentStatusReading | null
  unseen: boolean
  reviewGate: ProviderReviewGate | null
  providerBlocker: ProviderBlocker | null
  /** 声明了的状态来源读不出时的一句原因;`null` = 正常。 */
  statusSourceFault: string | null
}

export type AgentPresenceState = {
  agentUserId: string
  /** 粗分类(头像动效、群汇总、运行条、忙态),由 `presentation` 折出。 */
  status: AgentDisplayStatus
  /** 画成什么(tone、文案、动不动):可达 × 读数 → `presentAgentStatus`,与会话页、手机同一个函数。 */
  presentation: AgentStatusPresentation
  /** 这个 agent 此刻的读数:本机宿主的,没有才是云端那一行上的;`null` = 没有读数(老宿主、没有状态源)。 */
  reading: AgentStatusView | null
  /** 本机宿主按 agent 的流里的那一条;这台机器不是它的宿主时为 null。 */
  local: LocalAgentStatus | null
  payload: AgentPresencePayload | null
  deviceOnline: boolean
  error: string | null
  source: 'pending' | 'snapshot' | 'event' | 'local-overlay'
  lastUpdatedAt: number
  lastSnapshotAt: number | null
  lastEventAt: number | null
}

export type AgentPresenceListener = (state: AgentPresenceState) => void

// 刚确认过的读数不值得再问一遍;比这更旧的在**重新订阅时**对账一次。
// ⚠️ 这条不是「定期复查」,不在被删掉的那一类里:设备心跳不广播,所以一台机器恢复之后云端不会来通知。
// 缓存里那份载荷会随时钟诚实地掉成「不在线」——而那恰恰是最该去问一次的时刻。删掉它的后果是
// 一个活着的 agent 一直显示不在线,直到别的什么事凑巧触发一次拉取。
// 它也不改变状态:它只决定**什么时候去问**,答案仍然只由宿主给。
const REVALIDATE_AFTER_MS = 10_000

// @@@3839 这个 store 持有的是**知识**,不是订阅。谁在看只决定两件事:谁会被通知,以及是否值得为这个
// agent 花网络。观测过的 agent 不因视图卸载被遗忘 —— 展示态是 (payload, now) 的函数,而 payload 自带
// 时间戳:心跳过期时按当前时钟重算自然落到「不在线」,不需要网络往返,也没有撒谎。
// 于是 `pending` 收紧回它本来的意思:**从未观测过这个 agent**。
// (在此之前 refCount 归零就删 entry,而 MainLayout 的 tab 是会整块卸载的兄弟块 → 每次切 tab 都把
// 刚确认过的事实全丢掉、从 pending 重来并再付一次往返。见 #3839 的 A 读数。)
//
// 缓存是有界的:没有订阅者的 entry 只在时限/容量内保留,被淘汰之后它**确实**回到「从未观测过」,
// 那时再显示 `确认中` 是诚实的。
const COOLED_ENTRY_TTL_MS = 30 * 60 * 1000
const COOLED_ENTRY_MAX = 256

type Entry = {
  agentUserId: string
  state: AgentPresenceState
  listeners: Set<AgentPresenceListener>
  refCount: number
  // @@@1947 in-flight 快照去重改存 promise:并发调用共享同一次拉取且**可等待**(权威对账要在快照
  // 落地后读 entry.state,布尔式去重会让后到的调用者拿不到完成时机)。
  snapshotPromise: Promise<void> | null
  // @@@3839 离屏期间收到的权威变更:只记「该重问」,不当场发请求 —— 没人在看的 agent 不值得占网络,
  // 而重新订阅时先推缓存值再对账,所以这条延后不会让任何人看见 pending。
  dirty: boolean
  // @@@3839 冷却起点(最后一个订阅者离开、或预热建立的时刻)。TTL/容量淘汰只看它;null = 正被观察。
  cooledAt: number | null
  /** 本机宿主按 agent 的流里的那一条。没有本机腿、或这台机器不是它的宿主时为 null。 */
  local: LocalAgentStatus | null
}

const entries = new Map<string, Entry>()

let accountContext: { currentUserId: string | null } = { currentUserId: null }

// @@@3839 身份是缓存的边界:缓存里每一条都是**某个账号**观测到的,换了人就得重新观测。
export function setPresenceBusContext(ctx: { currentUserId: string | null }): void {
  const previousUserId = accountContext.currentUserId
  accountContext = ctx
  if (ctx.currentUserId === previousUserId) return
  // ⚠️ 只有**离开一个已登录身份**(登出 / 换人)才清空 —— 此前观测到的每一条都属于那个身份。
  // `null → 某个身份` 是**激活**,不是换人:那一刻屏上已经确认过的状态仍然是这个人自己的,
  // 把它打回 pending 只会在启动时白闪一次(shell 提交发生在会话列表已经订阅之后)。
  const leftAnIdentity = previousUserId !== null
  for (const entry of [...entries.values()]) {
    if (leftAnIdentity) {
      // 没人看的直接丢。有人看的退回 pending —— 这正是 pending 唯一合法的场合:
      // 对**新身份**而言这个 agent 确实从未观测过。❌ 不许把上一个账号的绿点留在屏上。
      if (entry.listeners.size === 0) {
        dropEntry(entry)
        continue
      }
      entry.state = neverObservedAgentPresence(entry.agentUserId)
      entry.local = null
      entry.dirty = false
      notify(entry)
    }
    if (ctx.currentUserId) void fetchSnapshot(entry)
  }
}

// The durable journal retains every changed agent id; only its realtime wake is throttled.
// Reconcile this batch's changed agents through the existing snapshot batching path.
export async function refreshObservedAgentPresenceFromRevision(payloads: readonly unknown[]): Promise<void> {
  const ids = new Set<string>()
  for (const payload of payloads) {
    const id = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { agent_user_id?: unknown }).agent_user_id : null
    if (typeof id !== 'string' || !id.trim()) throw new Error('presence_changed revision requires agent_user_id')
    ids.add(id)
  }
  await Promise.all([...ids].map(async (id) => {
    const entry = entries.get(id)
    if (!entry) return
    // A snapshot already in flight may predate this revision. Let it finish before
    // fetching again or marking a cooled entry dirty, so it cannot consume this change.
    if (entry.snapshotPromise) await entry.snapshotPromise
    if (entries.get(id) !== entry) return
    if (entry.listeners.size === 0) entry.dirty = true
    else await fetchSnapshot(entry, true)
  }))
}

/**
 * 本机宿主按 agent 的流里这个 agent 的那一条(`null` = 它不再绑在这台机器的任何会话上)。
 * **这是这张表唯一的本机写入口** —— 产品里只允许 agentStatusFeedBridge 调它(渲染层的单属主;❌ 新增第二个
 * 写入者)。❌ 不要从某个会话面调:挂在视图上的写入者只在自己挂载那段时间里说话,它写下的状态在视图卸载之后
 * 没有人来收尾。先后由那座桥按宿主的版本排好,到这里的就是最新的一条。
 */
export function setLocalAgentStatus(agentUserId: string, local: LocalAgentStatus | null): void {
  if (!agentUserId) throw new Error('local agent status has no agent id')
  const entry = local ? ensureEntry(agentUserId) : entries.get(agentUserId)
  if (!entry || sameLocal(entry.local, local)) return
  entry.local = local
  const projected = projectState(entry.state, Date.now(), entry.local)
  if (projected === entry.state) return
  entry.state = projected
  notify(entry)
}

function sameLocal(a: LocalAgentStatus | null, b: LocalAgentStatus | null): boolean {
  if (a === null || b === null) return a === b
  return a.sessionId === b.sessionId
    && a.unseen === b.unseen
    && a.reviewGate === b.reviewGate
    && a.providerBlocker?.reason === b.providerBlocker?.reason
    && a.providerBlocker?.message === b.providerBlocker?.message
    && a.statusSourceFault === b.statusSourceFault
    && JSON.stringify(a.reading) === JSON.stringify(b.reading)
}

export function subscribeAgentPresence(
  agentUserId: string,
  listener: AgentPresenceListener,
): () => void {
  const entry = ensureEntry(agentUserId)
  entry.listeners.add(listener)
  entry.refCount += 1
  if (entry.refCount === 1) revive(entry)
  // Synchronous push so the caller doesn't have to special-case the first render.
  queueMicrotask(() => {
    if (entry.listeners.has(listener)) listener(entry.state)
  })
  return () => {
    if (!entry.listeners.delete(listener)) return
    entry.refCount -= 1
    if (entry.refCount <= 0) cool(entry)
  }
}

// @@@5912 读到的就是存着的那一条 —— 这里不再有「按当前时钟重算一次」。
// 设备在不在线是库给的结论(status),它变了会作为一次边沿推过来;本机叠加(activity / 批准门)
// 在写入那一刻就已经折进 state。⇒ 这个函数不可能给出与 state 不同的答案,所以它不再投影。
export function getAgentPresenceSnapshot(agentUserId: string): AgentPresenceState | null {
  return entries.get(agentUserId)?.state ?? null
}

// @@@3839 从未观测过某个 agent 时的状态。**单点定义** —— 消费方(hook 的初始值)不得另起一份副本,
// 否则「什么算没观测过」会有两个口径。
export function neverObservedAgentPresence(agentUserId: string): AgentPresenceState {
  return {
    agentUserId,
    // An in-flight snapshot proves neither online nor offline. Keep the word neutral until the
    // authoritative payload arrives instead of flashing either false capability claim.
    status: 'pending',
    presentation: presentAgentStatus({ reading: null, reachability: 'pending' }),
    reading: null,
    local: null,
    payload: null,
    deviceOnline: false,
    error: null,
    source: 'pending',
    lastUpdatedAt: Date.now(),
    lastSnapshotAt: null,
    lastEventAt: null,
  }
}

// @@@3839 D — 让缓存在任何视图挂载**之前**就是暖的:会话列表一解析出它的 agent 成员就调这里,
// 之后无论用户先点进哪个 tab,那些 agent 都已被观测过。预热只建立知识、不建立订阅,所以预热出来的
// entry 一开始就是冷却态,照常受 TTL/容量约束。
export function prewarmAgentPresence(agentUserIds: readonly string[]): void {
  const now = Date.now()
  for (const agentUserId of agentUserIds) {
    if (!agentUserId) continue
    const existing = entries.get(agentUserId)
    if (existing) {
      if (existing.cooledAt !== null) existing.cooledAt = now
      continue
    }
    const entry = createEntry(agentUserId)
    entry.cooledAt = now
    void fetchSnapshot(entry)
  }
  evictCooledEntries()
}

function createEntry(agentUserId: string): Entry {
  const entry: Entry = {
    agentUserId,
    state: neverObservedAgentPresence(agentUserId),
    listeners: new Set(),
    refCount: 0,
    snapshotPromise: null,
    dirty: false,
    cooledAt: null,
    local: null,
  }
  entries.set(agentUserId, entry)
  return entry
}

function ensureEntry(agentUserId: string): Entry {
  const existing = entries.get(agentUserId)
  if (existing) return existing
  const entry = createEntry(agentUserId)
  void fetchSnapshot(entry)
  return entry
}

// @@@3839 第一个订阅者到达:只在**值得**时才对账(离屏期间来过权威变更,或这份读数已经不新鲜)。
// 全程不碰 status:'pending' —— 这个 agent 已经被观测过了。
// @@@5912 冷却期间不再「攒时间差」:离屏时设备下线会作为一次边沿进到 dirty,而不是等这里按时钟补算。
function revive(entry: Entry): void {
  entry.cooledAt = null
  if (!entry.state.payload) return
  // ⚠️ 新鲜度问的是「**上次听到服务端说话**是什么时候」,不是「上次动过这份 state」:
  // lastUpdatedAt 会被本机叠加盖成 now,用它判新鲜会在最该问的时候判成「刚确认过」。
  // 只有 lastSnapshotAt/lastEventAt 是观测时刻。
  if (entry.dirty || Date.now() - lastObservedAt(entry.state) >= REVALIDATE_AFTER_MS) {
    entry.dirty = false
    void fetchSnapshot(entry)
  }
}

function lastObservedAt(state: AgentPresenceState): number {
  return Math.max(state.lastSnapshotAt ?? 0, state.lastEventAt ?? 0)
}

// @@@3839 最后一个订阅者离开:停下为它花网络,但**留着已知的事实**。
function cool(entry: Entry): void {
  entry.cooledAt = Date.now()
  evictCooledEntries()
}

function dropEntry(entry: Entry): void {
  entries.delete(entry.agentUserId)
}

// @@@3839 缓存必须有界,否则一个长会话里的 agent 知识只增不减。淘汰只碰没有订阅者的 entry:
// 先按时限,再按「冷却得最久的先走」补到容量以内。
function evictCooledEntries(): void {
  const now = Date.now()
  const cooled: Entry[] = []
  for (const entry of entries.values()) {
    if (entry.cooledAt === null) continue
    if (now - entry.cooledAt >= COOLED_ENTRY_TTL_MS) {
      dropEntry(entry)
      continue
    }
    cooled.push(entry)
  }
  if (cooled.length <= COOLED_ENTRY_MAX) return
  cooled.sort((a, b) => (a.cooledAt ?? 0) - (b.cooledAt ?? 0))
  for (const entry of cooled.slice(0, cooled.length - COOLED_ENTRY_MAX)) dropEntry(entry)
}

// @@@5912 把本机那一条折进已存下的权威载荷。这里**没有时钟规则**:设备在不在线由载荷里的 status 直说,越过某个
// 窗口自己变暗的那条规则已经删掉 —— 那条规则正是「每个客户端各数一遍超时」的最后一处,而它要成立就得让库
// 把每一次心跳广播给每一个客户端。还没有权威载荷时展示态照旧是 pending(可达还没观测过),读数与本机那一条先记下。
function projectState(
  state: AgentPresenceState,
  now: number,
  local: LocalAgentStatus | null,
): AgentPresenceState {
  const payload = state.payload
  const reading = readingOf(payload, local)
  const deviceOnline = payload ? computeDeviceOnline(payload) : state.deviceOnline
  const presentation = payload ? presentationOf(payload, deviceOnline, reading, local) : state.presentation
  const unchanged = samePresentation(presentation, state.presentation) && deviceOnline === state.deviceOnline
    && sameLocal(state.local, local) && sameView(state.reading, reading)
  if (unchanged) return state
  const status = displayStatusOf(presentation.tone)
  return { ...state, status, presentation, deviceOnline, reading, local, source: 'local-overlay', lastUpdatedAt: now }
}

/** 本机就是这个 agent 的宿主 ⇒ 读本机那一条;否则读云端那一行上的读数(新宿主才写)。❌ 两条比版本。 */
function readingOf(payload: AgentPresencePayload | null, local: LocalAgentStatus | null): AgentStatusView | null {
  if (local) return local.reading ? { status: local.reading.status, detail: local.reading.detail } : null
  return payload?.status ?? null
}

function sameView(a: AgentStatusView | null, b: AgentStatusView | null): boolean {
  return a?.status === b?.status && a?.detail === b?.detail
}

function samePresentation(a: AgentStatusPresentation, b: AgentStatusPresentation): boolean {
  return a.tone === b.tone && a.label === b.label && a.animate === b.animate && a.emphasis === b.emphasis
}

/**
 * 可达 × 读数 → 画成什么。聊天侧没有「未读」这一轴(消息未读另有一套),做完不加粗。
 * 别处的老宿主不写读数(`reading` 为 null、本机也不是它的宿主):那一行的 running/idle 投影还能陈述「在跑」,
 * 只拿来画,❌ 当成读数存进 `reading`。
 */
function presentationOf(
  payload: AgentPresencePayload,
  deviceOnline: boolean,
  reading: AgentStatusView | null,
  local: LocalAgentStatus | null,
): AgentStatusPresentation {
  const reachability = deriveAgentReachability({
    accountStatus: payload.accountStatus,
    desiredStatus: payload.desiredStatus,
    deviceOnline,
  })
  return presentAgentStatus({ reading: reading ?? (local ? null : readingOfPresenceProjection(payload)), reachability })
}

// @@@3841 (#3839 的 E) 同一 tick 内的快照请求合成一次 RPC。
//
// 装在 fetchSnapshot **内部**而不是各调用点:这个 store 有 8 处会拉快照(激活、订阅、预热、对账、
// revive…),把合并做成调用方的责任意味着漏掉任何一处就退回 N 次往返,而漏没漏没有任何东西会报错。
// 装在这里,所有调用方自动受益,也没有第二条拉取路径需要维护。
//
// 上限与 identity.get_agent_presence_batch 的服务端上限一致;超了**分块**而不是截断——
// 截断会让一批 id 从来没被问过,而调用方拿到的是一份看起来完整的答案。
const BATCH_MAX_IDS = 200

type BatchWaiter = {
  entry: Entry
  throwOnError: boolean
  resolve: () => void
  reject: (error: unknown) => void
}

let batchQueue: BatchWaiter[] = []
let batchScheduled = false

function fetchSnapshot(entry: Entry, throwOnError = false): Promise<void> {
  if (entry.snapshotPromise) return entry.snapshotPromise
  const promise = new Promise<void>((resolve, reject) => {
    batchQueue.push({ entry, throwOnError, resolve, reject })
  })
  if (!batchScheduled) {
    batchScheduled = true
    queueMicrotask(flushSnapshotBatch)
  }
  entry.snapshotPromise = promise
  // 闩的释放必须在赋值之后挂(.finally 回调走微任务):若在 async 体内用 try/finally,body 在首个 await
  // 前同步抛时 finally 会先于外层赋值执行,置 null 随即被已 settle 的 promise 覆盖 → 闩永久卡死,该
  // agent 从此拉不到任何快照。带身份校验,不误清后来者。
  const clear = () => {
    if (entry.snapshotPromise === promise) entry.snapshotPromise = null
  }
  void promise.then(clear, clear)
  return promise
}

function flushSnapshotBatch(): void {
  batchScheduled = false
  const waiters = batchQueue
  batchQueue = []
  for (let i = 0; i < waiters.length; i += BATCH_MAX_IDS) {
    void runSnapshotBatch(waiters.slice(i, i + BATCH_MAX_IDS))
  }
}

/** 一个 waiter 的收尾:只有明确要求抛的调用方才会拿到 rejection —— 其余照旧「记进 state 然后 resolve」,
 *  否则 `void fetchSnapshot(entry)` 这类调用点会变成 unhandled rejection。 */
function settleWaiter(waiter: BatchWaiter, message: string | null): void {
  if (message === null) {
    waiter.resolve()
    return
  }
  if (entries.get(waiter.entry.agentUserId) === waiter.entry) applyError(waiter.entry, message)
  if (waiter.throwOnError) waiter.reject(new Error(message))
  else waiter.resolve()
}

async function runSnapshotBatch(waiters: BatchWaiter[]): Promise<void> {
  if (waiters.length === 0) return
  const ids = waiters.map((waiter) => waiter.entry.agentUserId)
  try {
    recordPresenceBatch(ids.length)
    const { data, error } = await dataClient
      .schema('identity')
      .rpc('get_agent_presence_batch', { p_agent_user_ids: ids })
    if (error) {
      for (const waiter of waiters) settleWaiter(waiter, error.message)
      return
    }
    const results = readBatchResults(data)
    if (!results) {
      for (const waiter of waiters) settleWaiter(waiter, 'Invalid agent presence batch snapshot')
      return
    }
    for (const waiter of waiters) {
      const agentUserId = waiter.entry.agentUserId
      // 身份校验:批次在飞的时候 entry 可能已被换号清空或淘汰,那份答案不再属于任何人。
      if (entries.get(agentUserId) !== waiter.entry) {
        waiter.resolve()
        continue
      }
      const result = results[agentUserId]
      // 服务端契约要求「问了的每个 id 都有一条结果」。少了 key 不是 not_found —— 那是契约被破坏,
      // ❌ 不许猜成任何一种结局,fail loud。
      if (!result || typeof result !== 'object') {
        settleWaiter(waiter, `Agent presence batch omitted ${agentUserId}`)
        continue
      }
      const status = (result as { status?: unknown }).status
      if (status === 'unauthorized') {
        settleWaiter(waiter, 'Agent presence is not viewable by current user')
        continue
      }
      if (status === 'not_found') {
        settleWaiter(waiter, `Agent presence not found: ${agentUserId}`)
        continue
      }
      if (status !== 'presence') {
        settleWaiter(waiter, `Unknown agent presence batch status for ${agentUserId}`)
        continue
      }
      const payload = parseAgentPresencePayload({ presence: (result as { presence?: unknown }).presence })
      if (!payload) {
        settleWaiter(waiter, 'Invalid agent presence snapshot')
        continue
      }
      applyPayload(waiter.entry, payload, 'snapshot')
      waiter.resolve()
    }
  } catch (err) {
    for (const waiter of waiters) settleWaiter(waiter, errorMessage(err))
  }
}

function readBatchResults(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const results = (raw as { results?: unknown }).results
  if (!results || typeof results !== 'object' || Array.isArray(results)) return null
  return results as Record<string, unknown>
}

function applyPayload(
  entry: Entry,
  payload: AgentPresencePayload,
  source: 'snapshot' | 'event',
): void {
  if (!shouldApplyAgentPresencePayload(entry.state.payload, payload)) return
  const now = Date.now()
  const deviceOnline = computeDeviceOnline(payload)
  const reading = readingOf(payload, entry.local)
  const presentation = presentationOf(payload, deviceOnline, reading, entry.local)
  const status = displayStatusOf(presentation.tone)
  const prev = entry.state
  // Heartbeats arrive far more often than the dot actually changes. Only the derived
  // status/deviceOnline (plus clearing a prior error) is user-visible — skip notify when
  // none of those moved so subscribers don't re-render on every identical heartbeat.
  // @@@recent-actions (#518) - also notify when the recent-action sequence changed, so the
  // hover/long-press badge reflects the agent's latest actions even while its derived status stays same.
  // @@@host-capability (#647) - also notify when host_runtime_capability changed (incl. null→value on the
  const changed =
    prev.status !== status ||
    !samePresentation(prev.presentation, presentation) ||
    prev.deviceOnline !== deviceOnline ||
    prev.error !== null ||
    prev.payload?.hostRuntimeCapability !== payload.hostRuntimeCapability ||
    prev.payload?.activityStatus !== payload.activityStatus ||
    !sameView(prev.reading, reading) ||
    !sameRecentActions(prev.payload?.recentActions, payload.recentActions)
  entry.state = {
    agentUserId: entry.agentUserId,
    status,
    presentation,
    reading,
    local: entry.local,
    payload,
    deviceOnline,
    error: null,
    source,
    lastUpdatedAt: now,
    lastSnapshotAt: source === 'snapshot' ? now : entry.state.lastSnapshotAt,
    lastEventAt: source === 'event' ? now : entry.state.lastEventAt,
  }
  entry.dirty = false
  if (changed) notify(entry)
}

export function shouldApplyAgentPresencePayload(
  current: AgentPresencePayload | null,
  incoming: AgentPresencePayload,
): boolean {
  if (!current) return true
  if (current.accountStatus === 'removed') {
    return incoming.accountStatus === 'removed'
      && Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
  }
  if (incoming.accountStatus === 'removed') return true
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
}

function applyError(entry: Entry, message: string): void {
  // Fail loudly — do NOT silently fall back to offline. Caller sees error in state + debug summary.
  const now = Date.now()
  entry.state = {
    ...entry.state,
    error: message,
    lastUpdatedAt: now,
  }
  notify(entry)
}

// @@@5912 设备在不在线 = 载荷里那一列。租约过期由服务端清扫者变成 status='offline' 并作为边沿推过来,
// ❌ 这里不再拿 deviceLastSeenAt 与本机时钟比 —— 那个比较两边来自两个钟,而且是心跳扇出的全部理由。
function computeDeviceOnline(payload: AgentPresencePayload): boolean {
  if (!payload.deviceId) return false
  if (!payload.deviceStatus) return false
  return isDeviceOnline(payload.deviceStatus)
}

function sameRecentActions(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false
  return true
}

function notify(entry: Entry): void {
  for (const listener of entry.listeners) listener(entry.state)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return 'unknown error'
  }
}
