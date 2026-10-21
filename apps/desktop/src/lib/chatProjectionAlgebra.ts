// @@@chat-projection — 渲染进程聊天投影的推进代数(纯函数、零 IO)。
//
// 合同在 product spec…/conversation-data/chat-projection/spec.md。本文件只承载那份合同里
// **代数**的那一半:键空间、按键版本格的 join、单飞/脏位规划、闭包、纯装配。
// 取数与账本在 chatProjection.ts;两者分开是为了让性质测试能直接驱动代数本体,
// 而不是驱动一份会与产品漂移的第二实现。
//
// 为什么是 join 而不是「后到的赢」:把归并定成「按键取戳最大者」之后,收敛、幂等、
// 与到达顺序无关这三件事就是这个代数的**定理**(见 spec 的 I1–I4),不再是调用点要守的纪律。

import { IN_FILTER_CHUNK } from '@gugu/core/shared/inChunks'
import type { ChatItem, ChatKind, ChatStatus, ChatUnreadLocator, GroupMemberRole, NotificationLevel } from '@gugu/core/shared/types/chat'
import { compareChatsByActivityDesc, fallbackChatName, isRoomChat } from '@gugu/core/shared/ui/chatModels'

/** 实体族 = 批量取数的单位:一个族一波,该族这一轮要的键按**有界批**放进 `in()`(见 FAMILY_BATCH_KEYS)。 */
export const ENTITY_FAMILIES = [
  'chat', 'membership', 'identity', 'unread', 'presence', 'preview', 'override',
] as const
export type EntityFamily = typeof ENTITY_FAMILIES[number]

const FAMILY_SET: ReadonlySet<string> = new Set(ENTITY_FAMILIES)

/**
 * @@@in-filter-budget — 一发能带多少键,由**实测的传输预算**推出;那个预算与推导只有**一处**属主:
 * `@gugu/core/shared/inChunks` 的 `IN_FILTER_CHUNK`(#5458)。本文件 ❌ 不再自己算一份 ——
 * 两个数必然漂移,而漂掉的那个只在会话多的账号上错。
 *
 * 需要的背景一句话:带**真实用户 session** 的 `in()` 在 URL 约 3.34–3.53 KiB 之间越界,失败是网络层
 * `net::ERR_FAILED`(JS 侧 = `TypeError: Failed to fetch`)—— 不是 HTTP 状态码,请求根本没发出去,
 * 所以只能在**规划期**就不越界。完整实测表、仪器与阳控读数在那个常量的注释里,
 * 读数在 gugu-base `evidence/2026-09-11-5394-cause-transport-budget/`,合同在 spec 的「键空间」一节。
 *
 * 键**不进** URL 的族(`unread` 一发拿回全部、`override` 按 owner 一发取全、`presence` 走 POST body)
 * 请求大小与键数无关 ⇒ 上界 ∞,分批只会把同一发打两遍。
 * ⇒ 一波的发数 = `Σ ⌈键/K_族⌉`,批间并行 ⇒ **仍是一波**;有界批只放大发数,不放大串行深度。
 */
export const FAMILY_BATCH_KEYS: Readonly<Record<EntityFamily, number>> = {
  chat: IN_FILTER_CHUNK,
  membership: IN_FILTER_CHUNK,
  identity: IN_FILTER_CHUNK,
  preview: IN_FILTER_CHUNK,
  unread: Number.POSITIVE_INFINITY,
  override: Number.POSITIVE_INFINITY,
  presence: Number.POSITIVE_INFINITY,
}

/** 把一族这一轮的键切成有界批(批间并行)。键数为 0 时没有批 —— ❌ 不发空 `in()`。 */
export function batchFamilyKeys(family: EntityFamily, ids: readonly string[]): string[][] {
  const limit = FAMILY_BATCH_KEYS[family]
  if (ids.length === 0) return []
  if (!(limit > 0)) throw new Error(`family ${family} has a non-positive batch limit`)
  if (ids.length <= limit) return [[...ids]]
  const batches: string[][] = []
  for (let index = 0; index < ids.length; index += limit) batches.push(ids.slice(index, index + limit))
  return batches
}

/** 稳定键 = `<族>:<id>`。membership 的 id 是 `<chatId>/<userId>`。 */
export type EntityKey = string

export function entityKey(family: EntityFamily, id: string): EntityKey {
  if (!FAMILY_SET.has(family)) throw new Error(`unknown entity family: ${family}`)
  if (!id) throw new Error(`entity key requires an id (family ${family})`)
  if (id.includes(':')) throw new Error(`entity id must not contain ':' (${family}:${id})`)
  return `${family}:${id}`
}

export function membershipId(chatId: string, userId: string): string {
  if (!chatId || !userId) throw new Error('membership key requires chatId and userId')
  return `${chatId}/${userId}`
}

export function splitKey(key: EntityKey): { family: EntityFamily; id: string } {
  const index = key.indexOf(':')
  if (index <= 0) throw new Error(`malformed entity key: ${key}`)
  const family = key.slice(0, index)
  if (!FAMILY_SET.has(family)) throw new Error(`malformed entity key: ${key}`)
  return { family: family as EntityFamily, id: key.slice(index + 1) }
}

export function splitMembershipId(id: string): { chatId: string; userId: string } {
  const index = id.indexOf('/')
  if (index <= 0) throw new Error(`malformed membership id: ${id}`)
  return { chatId: id.slice(0, index), userId: id.slice(index + 1) }
}

// ── 值形状(投影消费的那部分权威列,不是整行) ────────────────────────────────

export type ChatValue = {
  id: string
  public_id: number | null
  kind: ChatKind
  status: ChatStatus
  name: string | null
  avatar_url: string | null
  created_at: string
  last_message_at: string | null
  last_message_preview: string | null
  next_message_seq: number
  pinned_message_id: string | null
  // @@@5856 话题的溯源指针(仅 kind==='topic' 非空)。
  source_chat_id: string | null
  source_message_id: string | null
}

export type MembershipValue = {
  chat_id: string
  user_id: string
  last_read_seq: number
  is_marked_unread: boolean
  version: number
  notification_level: NotificationLevel
  is_pinned: boolean
  updated_at: string
  joined_at: string
  inbox_published: boolean
  role: GroupMemberRole | null
}

/** 完整的 display identity 行(装配只用它的**存在性**,消费者要整行)。 */
export type IdentityValue = { id: string } & Record<string, unknown>
export type UnreadValue = ChatUnreadLocator & { chat_id: string }
export type PresenceValue = { id: string; online: boolean }
/** viewer-scoped 最后一条可见消息:gated 成员看到的活动可能与 chat 行不同。 */
export type PreviewValue = { chat_id: string; created_at: string | null; preview: string | null }
export type OverrideValue = { contact_user_id: string; alias: string | null }

export type EntityValue =
  | ChatValue | MembershipValue | IdentityValue | UnreadValue | PresenceValue | PreviewValue | OverrideValue

/**
 * 一格缓存。`value === null` 表示**权威读没有返回该行** —— 那本身就是 tombstone,
 * 所以删除不需要特例(spec I3)。`stamp` 是发出该次取数时的游标,十进制字符串。
 */
export type Cell = { readonly value: EntityValue | null; readonly stamp: string }

export type ProjectionCache = ReadonlyMap<EntityKey, Cell>

const DECIMAL = /^(0|[1-9]\d*)$/

export function assertRevision(value: string, label: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new Error(`${label} must be a decimal revision string, got ${String(value)}`)
  }
  return value
}

/** 戳比较。BigInt —— revision 是 Postgres BIGINT,穿 JSON 时必须保持十进制字符串。 */
export function compareStamp(left: string, right: string): number {
  const a = BigInt(assertRevision(left, 'stamp'))
  const b = BigInt(assertRevision(right, 'stamp'))
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * ⊕ 的按键分量:取戳最大者。这是「按键版本格」上的 **join** ——
 * 可交换、可结合、幂等。戳相等时两个结果必然来自同一发(按键单飞,spec I2),故取任一;
 * 我们取既有值,使 join 在戳相等时是恒等映射(幂等的最强形式)。
 */
export function joinCell(current: Cell | undefined, incoming: Cell): Cell {
  if (!current) return incoming
  return compareStamp(incoming.stamp, current.stamp) > 0 ? incoming : current
}

/** 把一批取数结果 join 进缓存。与到达顺序无关(spec I3)。 */
export function mergeCells(
  cache: ProjectionCache,
  incoming: Iterable<readonly [EntityKey, Cell]>,
): ProjectionCache {
  const next = new Map(cache)
  for (const [key, cell] of incoming) {
    splitKey(key)
    assertRevision(cell.stamp, `cell stamp for ${key}`)
    next.set(key, joinCell(next.get(key), cell))
  }
  return next
}

/** 该键是否已新鲜到足以覆盖 revision r —— 已新鲜就**一发都不打**(spec I3 的「重放免费」)。 */
export function isFresh(cache: ProjectionCache, key: EntityKey, revision: string): boolean {
  const cell = cache.get(key)
  return !!cell && compareStamp(cell.stamp, revision) >= 0
}

// ── operation → 它命名了哪些键 ───────────────────────────────────────────────

export type ProjectionOperation = {
  revision: string
  event: string
  chatId: string | null
  entityId: string | null
}

/**
 * 一条 operation 命名的键。用 `resource_key` **定位要读什么**,
 * ❌ 不把 payload 当第二份业务真相(spec「投影是什么」)。
 * 未知 event 响亮失败 —— 静默忽略会让收敛证明的前提悄悄失效。
 */
export function operationKeys(operation: ProjectionOperation): EntityKey[] {
  const { event, chatId, entityId } = operation
  const chatKeys = (): EntityKey[] => {
    if (!chatId) throw new Error(`${event} revision requires chat_id`)
    return [entityKey('chat', chatId), entityKey('preview', chatId), entityKey('unread', chatId)]
  }
  switch (event) {
    case 'chat_changed':
    case 'chat_meta_changed':
      return [entityKey('chat', chatId ?? ''), entityKey('preview', chatId ?? '')]
    case 'message_created':
    case 'message_deleted':
    case 'reaction_changed':
    case 'delivery_changed':
      return chatKeys()
    case 'chat_members_changed':
      if (!chatId) throw new Error(`${event} revision requires chat_id`)
      // 成员行变化不改 chat 行 ⇒ 不顺带重读它。「已存在的会话刚被发布进我的收件箱」那一路
      // (open_dm 只写成员/publication、不发 chat_changed)由闭包补:我的成员行**蕴含**它的会话。
      // entityId 缺失时不知道是谁变了,退回读该会话的成员集合所依赖的 chat 行。
      return entityId
        ? [entityKey('membership', membershipId(chatId, entityId))]
        : [entityKey('chat', chatId)]
    case 'member_read_changed':
    case 'member_stream_read_changed':
      if (!chatId) throw new Error(`${event} revision requires chat_id`)
      return entityId
        ? [entityKey('membership', membershipId(chatId, entityId)), entityKey('unread', chatId)]
        : [entityKey('unread', chatId)]
    case 'presence_changed':
      if (!entityId) throw new Error(`${event} revision requires entity_id`)
      return [entityKey('presence', entityId)]
    case 'agent_changed':
      if (!entityId) throw new Error(`${event} revision requires entity_id`)
      return [entityKey('identity', entityId)]
    case 'friendship_changed':
    case 'friend_requests_changed':
      return entityId ? [entityKey('override', entityId)] : []
    // 这些 event 不投影进会话列表(有各自的属主面),但必须被承认 —— 承认为「零键」
    // 与「未知 event」是两件事,后者响亮失败。
    case 'group_collab_changed':
    case 'group_invitations_changed':
    case 'workspace_changed':
    case 'device_changed':
    case 'gugu_decision_event':
      return []
    default:
      throw new Error(`unknown account revision event: ${event}`)
  }
}

// ── 规划:脏位 + 按键单飞(spec I2) ────────────────────────────────────────

export type PlannerState = {
  /** 已被命名、但还没读到能覆盖该 revision 的值。值 = 需要覆盖的最高 revision。 */
  readonly dirty: ReadonlyMap<EntityKey, string>
  /** 在途的键 → 发出时的戳。同一键在途时不发第二发(单飞)。 */
  readonly inflight: ReadonlyMap<EntityKey, string>
}

export const EMPTY_PLANNER: PlannerState = { dirty: new Map(), inflight: new Map() }

/**
 * 观察一批 operation:命名的键若已新鲜则**不入脏**(重放免费);否则记下它需要覆盖的最高 revision。
 * 在途的键照样入脏 —— 在途那发的戳可能早于本 operation,落地后按脏位重取(spec I2)。
 */
export function observe(
  state: PlannerState,
  cache: ProjectionCache,
  operations: readonly ProjectionOperation[],
): PlannerState {
  let next = state
  for (const operation of operations) {
    assertRevision(operation.revision, 'operation revision')
    next = observeKeys(next, cache, operationKeys(operation), operation.revision)
  }
  return next
}

/**
 * 同一条规则的**键集合**入口:快照(`hydrate`)命名的是「我的会话」那一整组键,而不是某条 operation。
 * 走这里 ⇒ 快照与增量共用同一个新鲜度闸:**同一游标上重跑的快照,键已新鲜 ⇒ 一发都不打**
 * (spec I3「重放不是无害,是免费」;从前 `hydrate` 绕开这个闸直接标脏,于是同一游标被整轮重读一遍)。
 */
export function observeKeys(
  state: PlannerState,
  cache: ProjectionCache,
  keys: Iterable<EntityKey>,
  revision: string,
): PlannerState {
  assertRevision(revision, 'observed revision')
  let dirty: Map<EntityKey, string> | null = null
  for (const key of keys) {
    if (isFresh(cache, key, revision)) continue
    const inflightStamp = state.inflight.get(key)
    if (inflightStamp && compareStamp(inflightStamp, revision) >= 0) continue
    const existing = (dirty ?? state.dirty).get(key)
    if (existing && compareStamp(existing, revision) >= 0) continue
    dirty ??= new Map(state.dirty)
    dirty.set(key, revision)
  }
  return dirty ? { dirty, inflight: state.inflight } : state
}

/**
 * 这一波该取哪些键:脏且不在途。按族分组、每族切成**有界批**(`FAMILY_BATCH_KEYS`)——
 * 批间并行、族间并行 ⇒ **仍是一波**(spec I5)。返回的 state 把它们记为在途、从脏位移除。
 *
 * 分批放在这里(纯规划)而不是放在每个读函数里,是为了让「请求形状的上界」只有一个属主:
 * 调用方拿到的就已经是可以直接发的批,**没有一个可以忘记分批的入口**,账本也因此数得到真发数。
 */
export function planWave(
  state: PlannerState,
  stamp: string,
): { groups: Map<EntityFamily, string[][]>; next: PlannerState } {
  assertRevision(stamp, 'wave stamp')
  const claimed = new Map<EntityFamily, string[]>()
  const dirty = new Map(state.dirty)
  const inflight = new Map(state.inflight)
  for (const [key, needed] of state.dirty) {
    if (inflight.has(key)) continue
    if (compareStamp(stamp, needed) < 0) continue // 游标还没走到,这一发读不出它要的那次写入
    const { family, id } = splitKey(key)
    const bucket = claimed.get(family)
    if (bucket) bucket.push(id)
    else claimed.set(family, [id])
    dirty.delete(key)
    inflight.set(key, stamp)
  }
  const groups = new Map<EntityFamily, string[][]>()
  for (const [family, ids] of claimed) {
    ids.sort()
    groups.set(family, batchFamilyKeys(family, ids))
  }
  return { groups, next: { dirty, inflight } }
}

/** 一波落地:从在途移除。仍留在脏位的键(落地期间又被命名)下一波再取。 */
export function settleWave(state: PlannerState, keys: Iterable<EntityKey>): PlannerState {
  const inflight = new Map(state.inflight)
  for (const key of keys) inflight.delete(key)
  return { dirty: state.dirty, inflight }
}

/**
 * 一波**失败**:在途的键退回脏位,需要覆盖的 revision 至少是这一发的戳。
 *
 * 这是 I1/I4 的失败支,不是重试:失败的一发**没有**产生任何值,所以那些键既不该留在缓存里冒充新鲜,
 * 也不该留在在途表里 —— 留在在途表里的键 `planWave` 永远不再规划它(单飞的定义),于是一次网络抖动
 * 会让那些键**再也读不到**,症状是一个再也不更新的角落(实测:冷启 `membership` 那一发失败之后,
 * 后续每次 wake 都规划出空波、`requests=0`,派发方把「什么都没做」当成功确认,列表就永久停在空态)。
 * 退回脏位之后,恢复由既有机制自己完成:下一次 wake 的 `planWave` 会重新把它们规划进去。
 */
export function releaseWave(state: PlannerState, keys: Iterable<EntityKey>): PlannerState {
  const dirty = new Map(state.dirty)
  const inflight = new Map(state.inflight)
  for (const key of keys) {
    const stamp = inflight.get(key)
    if (stamp === undefined) continue
    inflight.delete(key)
    const existing = dirty.get(key)
    if (!existing || compareStamp(existing, stamp) < 0) dirty.set(key, stamp)
  }
  return { dirty, inflight }
}

// ── 批:折进同一次推进的若干次到达(单飞,批一级 —— 见 spec「单飞」那一节) ──────────

/** 一批 = 折进同一次推进的若干次到达。`head` 是它取数的戳,`from` 是最早那条 operation。 */
export type ProjectionBatch = { readonly head: string; readonly from: string; readonly trigger: readonly string[] }

/**
 * 把一次到达折进当前这一批:head 取较大者(更晚的游标只让这一批读得更新)、from 取较小者、
 * trigger 取并集。⚠️ ❌ 不是防抖 —— 它没有时钟,窗口的边界是「这一批还没开跑」。
 */
export function foldBatch(open: ProjectionBatch | null, arrival: ProjectionBatch): ProjectionBatch {
  assertRevision(arrival.head, 'batch head')
  assertRevision(arrival.from, 'batch from')
  if (!open) return arrival
  return {
    head: compareStamp(arrival.head, open.head) > 0 ? arrival.head : open.head,
    from: compareStamp(arrival.from, open.from) < 0 ? arrival.from : open.from,
    trigger: [...new Set([...open.trigger, ...arrival.trigger])],
  }
}

// ── 闭包:assemble 要用而缓存里没有的键(深度 ≤ 1,spec I5) ────────────────

/**
 * 缺失依赖 = 已在缓存里的会话所需、而缓存尚无的键。
 * 只会问「已知会话的成员」与「已知成员的身份」,不会引入新会话 ⇒ 闭包深度 ≤ 1,
 * 因此第二波之后必然为空;不为空就响亮失败,❌ 不循环补拉。
 */
export function missingDependencies(cache: ProjectionCache, viewerId: string): EntityKey[] {
  const missing = new Set<EntityKey>()
  const seenMembers = new Set<string>([viewerId])
  if (!cache.has(entityKey('identity', viewerId))) missing.add(entityKey('identity', viewerId))
  // 我的成员行**蕴含**它的会话:成员行在、chat 行不在,就是那条会话刚被发布进收件箱。
  for (const [key, cell] of cache) {
    const parsed = splitKey(key)
    if (parsed.family !== 'membership' || !cell.value) continue
    const { chatId, userId } = splitMembershipId(parsed.id)
    if (userId !== viewerId) continue
    if (!cache.has(entityKey('chat', chatId))) missing.add(entityKey('chat', chatId))
  }
  for (const [key, cell] of cache) {
    const { family, id } = splitKey(key)
    if (family !== 'chat' || !cell.value) continue
    for (const dependency of [entityKey('preview', id), entityKey('unread', id)]) {
      if (!cache.has(dependency)) missing.add(dependency)
    }
  }
  // 对端会话(dm/ai)的对端:装配要它的 identity **与** override(备注名)。
  // ⚠️ override 也必须在闭包里 —— 装配消费它,不问就等于冷启静默丢掉所有联系人备注。
  const peerChats = new Set<string>()
  for (const [key, cell] of cache) {
    const { family, id } = splitKey(key)
    if (family !== 'chat' || !cell.value) continue
    const kind = (cell.value as ChatValue).kind
    if (kind === 'dm' || kind === 'ai') peerChats.add(id)
  }
  for (const [key, cell] of cache) {
    const { family, id } = splitKey(key)
    if (family !== 'membership' || !cell.value) continue
    const { chatId, userId } = splitMembershipId(id)
    if (peerChats.has(chatId) && userId !== viewerId && !cache.has(entityKey('override', userId))) {
      missing.add(entityKey('override', userId))
    }
    if (seenMembers.has(userId)) continue
    seenMembers.add(userId)
    if (!cache.has(entityKey('identity', userId))) missing.add(entityKey('identity', userId))
  }
  return [...missing].sort()
}

// ── 装配:纯函数、零 IO ─────────────────────────────────────────────────────

function liveValues<T extends EntityValue>(cache: ProjectionCache, family: EntityFamily): Map<string, T> {
  const out = new Map<string, T>()
  for (const [key, cell] of cache) {
    const parsed = splitKey(key)
    if (parsed.family !== family || !cell.value) continue
    out.set(parsed.id, cell.value as T)
  }
  return out
}

/**
 * assemble : C → 会话列表。**纯函数、零 IO** —— 于是「界面为什么长这样」永远只由 C 回答,
 * 不必回答「哪次请求先到」(spec「投影是什么」)。
 */
export function assemble(cache: ProjectionCache, viewerId: string): ChatItem[] {
  if (!viewerId) throw new Error('assemble requires the viewer id')
  const chats = liveValues<ChatValue>(cache, 'chat')
  const memberships = liveValues<MembershipValue>(cache, 'membership')
  const identities = liveValues<IdentityValue>(cache, 'identity')
  const unread = liveValues<UnreadValue>(cache, 'unread')
  const previews = liveValues<PreviewValue>(cache, 'preview')
  const overrides = liveValues<OverrideValue>(cache, 'override')

  const membersByChat = new Map<string, MembershipValue[]>()
  for (const membership of memberships.values()) {
    const bucket = membersByChat.get(membership.chat_id)
    if (bucket) bucket.push(membership)
    else membersByChat.set(membership.chat_id, [membership])
  }
  for (const bucket of membersByChat.values()) {
    bucket.sort((left, right) => (
      left.joined_at === right.joined_at
        ? (left.user_id < right.user_id ? -1 : left.user_id > right.user_id ? 1 : 0)
        : (left.joined_at < right.joined_at ? -1 : 1)
    ))
  }

  const rows: ChatItem[] = []
  for (const chat of chats.values()) {
    if (chat.status !== 'active' && chat.status !== 'stopped' && chat.status !== 'paused') continue
    const own = memberships.get(membershipId(chat.id, viewerId))
    // inbox publication 是独立事实,不是 membership 副作用(conversation-data):
    // 没发布的会话不进列表。
    if (!own || !own.inbox_published) continue
    const isPeerChat = chat.kind === 'dm' || chat.kind === 'ai'
    const peers = (membersByChat.get(chat.id) ?? []).filter((member) => member.user_id !== viewerId)
    const peerUserId = isPeerChat ? (peers[0]?.user_id ?? null) : null
    // 身份引用只存稳定 id;peer 身份缺行时不把 name='' 当成功投影 ⇒ 该行不发布。
    if (isPeerChat && (!peerUserId || !identities.has(peerUserId))) continue
    const preview = previews.get(chat.id)
    const locator = unread.get(chat.id) ?? null
    const notificationLevel = own.notification_level
    rows.push({
      id: chat.id,
      public_id: chat.public_id,
      kind: chat.kind,
      status: chat.status,
      peer_user_id: peerUserId,
      peer_alias: peerUserId ? (overrides.get(peerUserId)?.alias ?? null) : null,
      avatar: isRoomChat(chat.kind) ? (chat.avatar_url ?? null) : null,
      // 群成员引用与对端同一条规则:身份缺行的成员不进这一行(下一条 agent_changed 一到就补上)。从前原样带上
      // 全部成员 id,读侧 readCompleteCachedChats 发现一个没身份就把整份冷启动缓存作废 —— 会话列表每次冷启都空白。
      member_user_ids: isRoomChat(chat.kind)
        ? (membersByChat.get(chat.id) ?? []).filter((member) => identities.has(member.user_id)).map((member) => member.user_id)
        : undefined,
      name: isRoomChat(chat.kind) ? (chat.name ?? fallbackChatName(chat.kind)) : '',
      created_at: chat.created_at,
      last_message_at: preview ? preview.created_at : chat.last_message_at,
      last_message_preview: preview ? preview.preview : chat.last_message_preview,
      unread_count: locator?.unread_count ?? 0,
      unread_locator: locator,
      pinned_message_id: chat.pinned_message_id,
      last_read_seq: own.last_read_seq,
      is_marked_unread: own.is_marked_unread,
      read_state_version: own.version,
      member_updated_at: own.updated_at,
      next_message_seq: chat.next_message_seq,
      is_pinned: own.is_pinned,
      notification_level: notificationLevel,
      is_muted: notificationLevel === 'none',
      my_role: isRoomChat(chat.kind) ? own.role : undefined,
      source_chat_id: chat.source_chat_id,
      source_message_id: chat.source_message_id,
    })
  }
  rows.sort(compareChatsByActivityDesc)
  return rows
}
