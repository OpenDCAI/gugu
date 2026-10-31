// @@@chat-projection — 投影的取数与账本(合同的 IO 那一半)。
//
// 代数在 chatProjectionAlgebra.ts(纯函数,性质测试直接驱动它)。本文件是那份代数的
// **唯一属主**:它独占缓存 C、游标、单飞表、脏位与 assemble,并且是实体族读函数的唯一调用点
// (spec I7)。其它组件只读 `subscribe` 出来的 ChatItem[]。
//
// 快照与增量走**同一条**取数路径,区别只在这一轮的键从哪来(spec「输入」):
// - **快照**(`hydrate`)= 一次「哪些会话属于我」的读拿到键集合(那不是某个实体的值,是键集合本身),
//   然后走同一套族读与 assemble ⇒ 2 波。
// - **增量**(`advance`)= journal 命名哪个实体就只读那个实体 ⇒ ≤2 波(I5)。
// 会话列表的云端取数只有这一条路(I7):从前冷启另走 `chatListLoader` 的 8 波串行链,
// 那就是第二个属主在原地 —— #3271 的病只治了增量那一半。

import type { ChatItem, ChatUnreadLocator, GroupMemberRole, NotificationLevel } from '@gugu/core/shared/types/chat'
import { isPendingDelivery, turnFailureReason } from '@gugu/core/shared/ui/systemNotice'
import {
  assemble,
  assertRevision,
  entityKey,
  foldBatch,
  EMPTY_PLANNER,
  membershipId,
  mergeCells,
  missingDependencies,
  observe,
  observeKeys,
  planWave,
  releaseWave,
  settleWave,
  splitKey,
  splitMembershipId,
  type Cell,
  type EntityFamily,
  type EntityKey,
  type PlannerState,
  type ProjectionBatch,
  type ProjectionCache,
  type ProjectionOperation,
} from './chatProjectionAlgebra'
import { ACCOUNT_REVISION_CURSOR_KEY, type AccountRevisionOperation } from './accountRevisionRuntime'
import {
  readRevisionResourceKey,
  type AccountRevisionEvent,
  type AccountRevisionListener,
} from './accountRevisionCoordinator'
import { imSelectors, type AccountImRepository } from './imRepository'
import { readDisplayIdentities } from './identityReadAdapter'
import type { DisplayIdentity } from './displayIdentity'
import { rendererLogger } from './log'
import { chatDb, identityDb } from './supabase'
import { composerCardLine } from './composerCardCopy'

const log = rendererLogger('chat/projection')

/**
 * 一族一批的读函数:`ids` 已经是 `planWave` 切好的**有界批**(`FAMILY_BATCH_KEYS`),
 * 所以这里 ❌ 不再自己分批 —— 请求形状的上界只有一个属主,读函数只管把一批发出去。
 * 批间与族间都并行 ⇒ 波数仍是串行深度,发数是 `Σ ⌈键/K⌉`。
 */
type FamilyReader = (ids: readonly string[], signal: AbortSignal) => Promise<Map<string, unknown>>

export type ChatProjectionLedgerEntry = {
  trigger: string[]
  revisions: [string, string]
  keysDirty: number
  requestsByFamily: Record<string, number>
  requests: number
  waves: number
  ms: number
  /** 这一次推进有没有走完。失败也写一行 —— 沉默的失败会让空列表看起来像「本来就没有会话」。 */
  ok: boolean
  error?: string
  /**
   * 这一行不是「读失败」,是**生命周期取消**(登出/换账号把 signal abort 了)。
   * 两者都写行(沉默不是读数),但**必须能分开**:取消当成失败会让读数里凭空多出缺陷
   * (#2187 已经为此在 store 侧分过一次),失败当成取消则会把真缺陷藏掉。
   */
  aborted?: boolean
}

export type ChatProjection = {
  /**
   * 冷启快照:一次「哪些会话属于我」的读 → 键集合 → **与增量同一套**族读与 assemble ⇒ 2 波。
   * 没有第二条拉取路(I7),也没有第二份装配逻辑。
   */
  hydrate: (cursor: string, signal: AbortSignal) => Promise<ChatItem[]>
  /** 把一批 operation 折进**当前这一批推进**,返回那次推进的结果(未产生变化时 null)。 */
  advance: (operations: readonly ProjectionOperation[], cursor: string, signal: AbortSignal) => Promise<ChatItem[] | null>
  /** 接到 revision 派发上:认领哪些 event、payload 怎么变成键、批怎么合成,全在本域(I7)。 */
  attach: (attachment: ChatProjectionAttachment) => () => void
  /** 本地写的权威回执:按它发布的 revision 作戳进 C ⇒ 回声零发(spec I6)。 */
  ingestLocalWrite: (cells: Iterable<readonly [EntityKey, Cell]>) => ChatItem[]
  current: () => ChatItem[]
  /** 已投影出的身份 —— 交给 applyFetchedChatList,与行**一起**登记(#4314)。 */
  identities: () => DisplayIdentity[]
  /**
   * 「我在这条会话里的成员行**权威地不存在**」。
   * 这是撤销当前选中的判据(#4314):一个具体实体的权威读数,而不是从整表缺席反推 ——
   * 缺席在乐观行与投影滞后时会误伤,tombstone 不会。**从没读过**这个键时返回 false:
   * 沉默是仪器还没读到,不是阴性读数。
   */
  isMembershipRevoked: (chatId: string) => boolean
  ledger: () => readonly ChatProjectionLedgerEntry[]
  reset: () => void
}

/** store 交给投影的四件事:怎么认领、游标从哪读、用哪个 signal、行怎么发布。 */
export type ChatProjectionAttachment = {
  subscribe: (events: readonly AccountRevisionEvent[], listener: AccountRevisionListener) => () => void
  cursor: () => string
  signal: () => AbortSignal
  publish: (rows: ChatItem[]) => Promise<void>
}

/** 会话域的 event —— 它们的 payload 带 chat_id;其余只带实体 id。 */
const CHAT_SCOPED_EVENTS = [
  'chat_changed', 'chat_meta_changed', 'chat_members_changed',
  'member_read_changed', 'member_stream_read_changed',
  'message_created', 'message_deleted', 'reaction_changed', 'delivery_changed',
] as const satisfies readonly AccountRevisionEvent[]

/**
 * 投影认领的 event。⚠️ presence 不在其中:在线状态的属主是 agentPresenceStore,
 * `ChatItem` 里也没有在线字段 —— 投影再拉一遍就是第二个属主(spec I7 反过来也成立)。
 */
export const PROJECTED_REVISION_EVENTS = [
  ...CHAT_SCOPED_EVENTS, 'agent_changed', 'friendship_changed',
] as const satisfies readonly AccountRevisionEvent[]

const CHAT_SCOPED: ReadonlySet<string> = new Set(CHAT_SCOPED_EVENTS)
const ENTITY_ID_FIELDS = ['entity_id', 'user_id', 'agent_user_id', 'contact_user_id', 'user_b_id'] as const

/** operation 的 `resource_key` → 它命名的键所需的 (chatId, entityId)。畸形响亮失败,❌ 不静默当 null。 */
export function toProjectionOperations(operations: readonly AccountRevisionOperation[]): ProjectionOperation[] {
  return operations.map(({ revision, event, payload }) => {
    if (CHAT_SCOPED.has(event)) {
      return { revision, event, ...readRevisionResourceKey(payload, event as AccountRevisionEvent) }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`${event} revision payload is malformed`)
    const raw = payload as Record<string, unknown>
    const field = ENTITY_ID_FIELDS.find((name) => typeof raw[name] === 'string' && raw[name])
    return { revision, event, chatId: null, entityId: field ? String(raw[field]) : null }
  })
}

/** 已提交的 journal 游标 —— 取数结果的戳(spec I1)。还没同步过时是 0。 */
export function readProjectionCursor(repository: AccountImRepository | null): string {
  const value = repository && imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())
  const revision = (value as { revision?: unknown } | null | undefined)?.revision
  return typeof revision === 'string' && /^(0|[1-9]\d*)$/.test(revision) ? revision : '0'
}

export function createChatProjection(viewerId: string): ChatProjection {
  if (!viewerId) throw new Error('chat projection requires the viewer id')

  let cache: ProjectionCache = new Map()
  let planner: PlannerState = EMPTY_PLANNER
  let rows: ChatItem[] = []
  const ledger: ChatProjectionLedgerEntry[] = []
  // 调度:`open` = 已折进、还没开跑的那一批(开跑即关批);`inflight` = 在跑/已排队那次的结果;
  // `tail` 把推进串行化(并发推进会让同一个键被两发,违 I2)且永不 reject —— 它只承载次序。
  let open: { batch: ProjectionBatch; snapshot: boolean; signal: AbortSignal; settled: Promise<ChatItem[] | null> } | null = null
  let inflight: Promise<ChatItem[] | null> | null = null
  let tail: Promise<unknown> = Promise.resolve()
  /**
   * 已建立**完整快照**的游标(null = 一次都没成功过)。它是快照那一路的新鲜度戳:
   * 同一游标上再 hydrate 一次是重放 ⇒ 一发都不打;而 null 意味着「键集合本身都还没读到」,
   * 那时任何一次 wake 都要顺带把快照重建起来 —— 增量只认识 journal 命名的键,建不出整张列表。
   */
  let snapshotAt: string | null = null

  const readers: Record<EntityFamily, FamilyReader> = {
    chat: async (ids, signal) => {
      const { data, error } = await chatDb.from('chats')
        .select('id, public_id, kind, status, name, avatar_url, created_at, last_message_at, last_message_preview, next_message_seq, pinned_message_id, source_chat_id, source_message_id')
        .in('id', [...ids]).abortSignal(signal)
      if (error) throw new Error(error.message)
      const found = (data ?? []) as Array<Record<string, unknown> & { id: string }>
      return indexBy(ids, found, (row) => row.id)
    },
    membership: async (ids, signal) => {
      // membership 的键是 <chatId>/<userId>。按 chat 分组成一次 in(),再按键落位。
      const parsed = ids.map((id) => ({ id, ...splitMembershipId(id) }))
      const chatIds = [...new Set(parsed.map((entry) => entry.chatId))]
      const { data, error } = await chatDb.from('chat_members')
        .select('chat_id, user_id, last_read_seq, is_marked_unread, version, notification_level, is_pinned, updated_at, joined_at, inbox_published_at, role')
        .in('chat_id', chatIds).abortSignal(signal)
      if (error) throw new Error(error.message)
      const found = (data ?? []) as Array<Record<string, unknown> & { chat_id: string; user_id: string }>
      const byKey = new Map<string, unknown>()
      for (const row of found) byKey.set(membershipId(row.chat_id, row.user_id), membershipValue(row))
      // 这一发是按 chat 取的 ⇒ 它已经把这些会话的**全部**成员行拿回来了。把它们一起落位:
      // 丢掉再去问一遍就是白花一发(快照那一路的同伴成员行正是这么来的)。
      // 请求过但没回来的键仍然落 `null` —— 那是它的 tombstone(spec I3)。
      return new Map([...byKey, ...indexExact(ids, byKey)])
    },
    identity: async (ids, signal) => {
      // 身份格里存**完整** DisplayIdentity —— applyFetchedChatList 与各处 identity selector
      // 消费的是那整行;只存 {id,name} 会让「有身份」与「能显示」错开(#4314 的 name='' 陷阱)。
      const found = await readDisplayIdentities([...ids], signal)
      const byId = new Map<string, unknown>()
      for (const identity of found) byId.set(identity.id, identity)
      return indexExact(ids, byId)
    },
    unread: async (ids, signal) => {
      // list_unread_locators 是服务端的未读投影,按 chat 落位。一批里只脏了一条会话(忙群里几乎每一批都是)就只问它:
      // 问全部要把每条会话的每个流重算一遍再整包拿回来。这条会话我已经不在了,服务端会拒 ⇒ 退回问全部,缺行即 tombstone。
      const only = ids.length === 1 ? ids[0]! : null
      let { data, error } = await chatDb.rpc('list_unread_locators', { p_chat_id: only }).abortSignal(signal)
      if (error && only) ({ data, error } = await chatDb.rpc('list_unread_locators', { p_chat_id: null }).abortSignal(signal))
      if (error) throw new Error(error.message)
      const byChat = mergeUnreadRows((data ?? []) as Array<Record<string, unknown> & { chat_id: string }>)
      return indexExact(ids, byChat as Map<string, unknown>)
    },
    presence: async (ids, signal) => {
      const { data, error } = await identityDb.rpc('get_agent_presence_batch', { p_agent_user_ids: [...ids] }).abortSignal(signal)
      if (error) throw new Error(error.message)
      const byId = new Map<string, unknown>()
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const id = String(row.agent_user_id ?? row.user_id ?? '')
        if (id) byId.set(id, { id, online: row.is_online === true || row.online === true })
      }
      // presence 缺行 = 不在线,不是「读不到」⇒ 显式投影成 offline,❌ 留 undefined 让 UI 猜。
      return new Map([...ids].map((id) => [id, byId.get(id) ?? { id, online: false }]))
    },
    preview: async (ids, signal) => {
      // @@@chat-list-visibility — `messages_view` 是 `security_invoker = true` 的视图 ⇒ 走的是
      // `messages` 那套 RLS:成员门 + `hide_history_before` 门 + whisper 门 + `deleted_at IS NULL`
      // 都由数据库施加。所以列表 preview 与 transcript **消费同一成员可见性**,而且对每条会话
      // 一视同仁、一发拿回 —— 从前只对带门的会话逐会话重算(与带门会话数成正比)。
      // `is_whisper=false` 仍显式排除:RLS 会把发给我的私语放行,但它从前不进列表预览,这里不改产品行为。
      const { data, error } = await chatDb.from('messages_view')
        .select('id, chat_id, created_at, preview, seq, content_type, sender_user_id, client_message_id')
        .in('chat_id', [...ids]).eq('is_whisper', false)
        .order('seq', { ascending: false }).limit(ids.length * 4)
        .abortSignal(signal)
      if (error) throw new Error(error.message)
      const found = (data ?? []) as Array<Record<string, unknown> & { chat_id: string } & Parameters<typeof turnFailureReason>[0]>
      const byChat = new Map<string, unknown>()
      for (const row of found) {
        // 还在等 agent 接走的那种行不画(气泡上说),也不当预览;与 sync_snapshot 的 chat.is_pending_delivery 同一判据。
        if (byChat.has(row.chat_id) || isPendingDelivery(row)) continue
        byChat.set(row.chat_id, {
          chat_id: row.chat_id,
          created_at: String(row.created_at),
          // 预览在库里算好(messages_view 的计算列 preview:附件给文件名、其它截 100 字),这里原样用;
          // 任务卡截出来是半截 JSON,读回成一行原话(gugu-dev#181,serializeComposerCard 让原话排在前面)。
          preview: typeof row.preview === 'string' ? composerCardLine(row.preview) : null,
          // 最后一条是 agent 的失败行:列表按看的人的语言说它的原因(systemNotice.ts),❌ 显示那句给 agent 读的英文。
          failure: turnFailureReason(row),
        })
      }
      return indexExact(ids, byChat)
    },
    override: async (ids, signal) => {
      const { data, error } = await identityDb.from('contact_overrides')
        .select('target_kind, target_id, alias').eq('owner_user_id', viewerId).abortSignal(signal)
      if (error) throw new Error(error.message)
      const byId = new Map<string, unknown>()
      for (const row of (data ?? []) as Array<{ target_kind: string; target_id: string; alias: string | null }>) {
        byId.set(row.target_kind === 'group' ? `group/${row.target_id}` : row.target_id, { alias: row.alias })
      }
      return indexExact(ids, byId)
    },
  }

  const identitySnapshot = (): DisplayIdentity[] => {
    const out: DisplayIdentity[] = []
    for (const [key, cell] of cache) {
      const parsed = splitKey(key)
      if (parsed.family !== 'identity' || !cell.value) continue
      out.push(cell.value as unknown as DisplayIdentity)
    }
    return out
  }

  const record = (entry: ChatProjectionLedgerEntry): void => {
    ledger.push(entry)
    if (ledger.length > 200) ledger.shift()
    // 账本 = 这一层的读数出口(#5414 的量法直接读它),不是产品内测试探针。
    if (entry.ok) log.info(entry, 'chat projection advanced')
    else if (entry.aborted) log.warn(entry, 'chat projection cancelled')
    else log.error(entry, 'chat projection failed')
  }

  /**
   * 波循环:一波 = 这一轮的**全部批**并行取数(族间并行、同族的批之间也并行)。
   * 闭包深度 ≤ 1 ⇒ 最多两波实体读;超出预算即响亮失败,❌ 不循环补拉(那正是 #5394 的病)。
   * 返回这次花掉的发数 —— 数的是**真发出去的请求**(批数),不是族数:
   * N=200 时 `chat` 一族是 2 发,账本写 1 就是把自己的代价瞒掉了(判据要能看见它)。
   *
   * 失败:把这一波在途的键退回脏位(`releaseWave`)、写一行失败账本、原样抛出。
   * ❌ 不吞、❌ 不重试 —— 重读由下一次 wake 的 `planWave` 自己做到(spec I1/I4 的失败支)。
   */
  const runWaves = async (
    cursor: string,
    signal: AbortSignal,
    context: { trigger: string[]; from: string; requests?: number },
  ): Promise<number> => {
    const startedAt = Date.now()
    const requestsByFamily: Record<string, number> = { ...(context.requests ? { keyset: context.requests } : {}) }
    let requests = context.requests ?? 0
    let waves = 0
    const dirtyAtEntry = planner.dirty.size
    let guard = 0
    const failWith = (err: unknown): never => {
      // 判据是 signal 自己的状态,❌ 不是错误文字里有没有 'abort':后者会把服务端某天改了措辞
      // 的真失败误判成取消。
      const aborted = signal.aborted
      record({
        trigger: context.trigger,
        revisions: [context.from, cursor],
        keysDirty: dirtyAtEntry,
        requestsByFamily,
        requests,
        waves,
        ms: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(aborted ? { aborted: true } : {}),
      })
      throw err
    }
    for (;;) {
      if (guard++ > 3) failWith(new Error('chat projection did not settle within the bounded wave budget'))
      const planned = planWave(planner, cursor)
      if (planned.groups.size === 0) break
      waves += 1
      // 这一波的在途键 —— 失败时要原样退回脏位,否则单飞表会把它们永久扣住。
      const claimed: EntityKey[] = []
      for (const [family, batches] of planned.groups) {
        for (const batch of batches) for (const id of batch) claimed.push(entityKey(family, id))
      }
      const issued = [...planned.groups.entries()].flatMap(([family, batches]) =>
        batches.map((batch) => [family, batch] as const))
      planner = planned.next
      let results: ReadonlyArray<readonly [EntityFamily, Map<string, unknown>]>
      try {
        results = await Promise.all(issued.map(async ([family, batch]) => {
          requests += 1
          requestsByFamily[family] = (requestsByFamily[family] ?? 0) + 1
          return [family, await readers[family](batch, signal)] as const
        }))
        signal.throwIfAborted()
      } catch (err) {
        planner = releaseWave(planner, claimed)
        return failWith(err)
      }
      const cells: Array<readonly [EntityKey, Cell]> = []
      const settled: EntityKey[] = []
      for (const [family, byId] of results) {
        for (const [id, value] of byId) {
          const key = entityKey(family, id)
          cells.push([key, { value: (value ?? null) as Cell['value'], stamp: cursor }])
          settled.push(key)
        }
      }
      cache = mergeCells(cache, cells)
      // 请求过但一个批都没提到的键(理论上不该有)也要出在途表,否则它会被永久扣住。
      planner = settleWave(planner, [...settled, ...claimed])

      const missing = missingDependencies(cache, viewerId)
      if (missing.length === 0) continue
      const dirty = new Map(planner.dirty)
      for (const key of missing) dirty.set(key, cursor)
      planner = { dirty, inflight: planner.inflight }
    }
    record({
      trigger: context.trigger,
      revisions: [context.from, cursor],
      keysDirty: dirtyAtEntry,
      requestsByFamily,
      requests,
      waves,
      ms: Date.now() - startedAt,
      ok: true,
    })
    return requests
  }

  const republish = (): ChatItem[] => {
    rows = assemble(cache, viewerId)
    return rows
  }

  /**
   * 快照的键集合:一次「我的、已发布进收件箱的成员行」的读 —— 那不是某个实体的值,是键集合本身。
   * `inbox_published_at is not null` 是 conversation-data 的既有不变量:没发布的会话不进列表。
   * 键走 `observeKeys` 入脏,与增量共用同一个新鲜度闸(已新鲜的键不入脏 ⇒ 同一游标上重放免费)。
   */
  const observeSnapshotKeys = async (cursor: string, signal: AbortSignal): Promise<void> => {
    const { data, error } = await chatDb.from('chat_members')
      .select('chat_id').eq('user_id', viewerId).not('inbox_published_at', 'is', null).abortSignal(signal)
    if (error) throw new Error(error.message)
    const chatIds = [...new Set((data ?? []).map((row) => String((row as { chat_id: unknown }).chat_id)))]
    const keys: EntityKey[] = []
    for (const chatId of chatIds) {
      // 我的成员行 + 那条会话本身 + 它的预览与未读。同伴成员行由 membership 那一发顺带带回,
      // 缺失的身份由闭包补 ⇒ 一共 2 波(spec「输入 1」)。
      keys.push(entityKey('membership', membershipId(chatId, viewerId)))
      for (const family of ['chat', 'preview', 'unread'] as const) keys.push(entityKey(family, chatId))
    }
    // ❌ 不在这里点名 identity(viewerId):闭包本来就会补它,那时它与对端身份**合成同一发**。
    // 提前点名只会让 identity 族被读两次(两波各一次)—— 波数没变,发数白多一个。
    planner = observeKeys(planner, cache, keys, cursor)
  }

  /**
   * 一次推进 = 一批。快照与增量走的是**同一个调度器**:同一时刻至多一次推进在跑
   * (并发推进会让同一个键被两发,违 I2),还没开跑的批把后来的到达折进来(批单飞)。
   * 快照从前自己一条路、不进这个调度器 ⇒ 同一游标被整轮读两遍(实测两行 `trigger:['hydrate']`)。
   */
  const schedule = (arrival: ProjectionBatch, snapshot: boolean, signal: AbortSignal): Promise<ChatItem[] | null> => {
    // 这一批还没开跑 ⇒ 折进它。同一 wake 的 k 类 event、以及同时落进来的 hydrate 走的都是这一支。
    if (open) {
      open.batch = foldBatch(open.batch, arrival)
      open.snapshot = open.snapshot || snapshot
      return open.settled
    }
    // 脏位空 ⇒ 这批命名的键都已被一次更新的读覆盖:一发都不打(head 去重)。在途时交回在途那发 ——
    // 它成功之前这一批不该被确认。「0 发」写自己那一行,不混进推进行的计数里(沉默不是读数)。
    // ⚠️ 快照不能走这个判据:它的键还没读到,脏位空只说明「还不知道要读什么」。
    if (!snapshot && planner.dirty.size === 0) {
      if (inflight) return inflight
      log.info({ trigger: arrival.trigger, head: arrival.head }, 'chat projection wake covered')
      return Promise.resolve(null)
    }
    const startBatch = async (): Promise<ChatItem[] | null> => {
      const { batch, snapshot: isSnapshot, signal: batchSignal } = open!
      open = null // 开跑即关批
      const trigger = isSnapshot ? [...new Set(['hydrate', ...batch.trigger])] : [...batch.trigger]
      let keysetRequests = 0
      if (isSnapshot && snapshotAt === batch.head) {
        // 排队期间前一批已经在这个游标上建好了完整快照 ⇒ 这一批是重放,连键集合那一读都不必发。
        log.info({ trigger, head: batch.head }, 'chat projection snapshot covered')
        return null
      }
      if (isSnapshot) {
        await observeSnapshotKeys(batch.head, batchSignal)
        keysetRequests = 1
      } else if (planner.dirty.size === 0) {
        // 排队期间上一批把这些键一起排掉了(共享脏位)⇒ 这一批无事可做。
        log.info({ trigger, head: batch.head }, 'chat projection wake covered')
        return null
      }
      const spent = await runWaves(batch.head, batchSignal, { trigger, from: batch.from, requests: keysetRequests })
      // 快照成功 ⇒ 这个游标上有了完整快照;失败时 runWaves 已经抛出,这行不会执行(戳不前进)。
      if (isSnapshot) snapshotAt = batch.head
      return isSnapshot || spent > 0 ? republish() : null
    }
    const settled = tail.then(startBatch, startBatch)
    open = { batch: arrival, snapshot, signal, settled }
    inflight = settled
    // tail 消费掉失败(不留 unhandled rejection),但失败照样原样交给每个折进这一批的调用方。
    const clear = () => { if (inflight === settled) inflight = null }
    tail = settled.then(clear, clear)
    return settled
  }

  const owner: ChatProjection = {
    async hydrate(cursor, signal) {
      assertRevision(cursor, 'projection cursor')
      // 同一游标上已经有完整快照 ⇒ 这是一次重放,一发都不打(spec I3:重放不是无害,是免费)。
      // 从前每次 `loadChats()` 都无条件整轮重读一遍,同一游标两行 `hydrate` 就是这么来的。
      if (snapshotAt === cursor) {
        log.info({ trigger: ['hydrate'], head: cursor }, 'chat projection snapshot covered')
        return rows
      }
      const next = await schedule({ head: cursor, from: cursor, trigger: ['hydrate'] }, true, signal)
      return next ?? rows
    },

    async advance(operations, cursor, signal) {
      assertRevision(cursor, 'projection cursor')
      // observe 是幂等的:已新鲜的键、以及在途那发的戳已 ≥ 本 operation 的键,都**不入脏**。
      planner = observe(planner, cache, operations)
      const arrival: ProjectionBatch = {
        head: cursor,
        from: operations.length > 0 ? operations[0]!.revision : cursor,
        trigger: [...new Set(operations.map((operation) => operation.event))],
      }
      // 一次完整快照都还没成立(冷启那一发失败过)⇒ 这次 wake 顺带把它重建起来。
      // 增量只认识 journal 命名的那几个键,建不出整张列表;❌ 不是重试循环,是「缺快照」这个状态本身。
      return schedule(arrival, snapshotAt === null, signal)
    },

    ingestLocalWrite(cells) {
      cache = mergeCells(cache, cells)
      return republish()
    },

    current: () => rows,
    identities: identitySnapshot,
    isMembershipRevoked(chatId) {
      const cell = cache.get(entityKey('membership', membershipId(chatId, viewerId)))
      // 从没读过这个键 ⇒ false。沉默是仪器还没读到,不是阴性读数(铁律 2)。
      return !!cell && cell.value === null
    },
    ledger: () => ledger,
    attach({ subscribe, cursor, signal, publish }) {
      return subscribe(PROJECTED_REVISION_EVENTS, async (operations) => {
        const next = await owner.advance(toProjectionOperations(operations), cursor(), signal())
        if (next === null) return // 键已新鲜 ⇒ 零发、零重绘(spec I3/I6)
        await publish(next)
      })
    },
    reset() {
      cache = new Map()
      planner = EMPTY_PLANNER
      rows = []
      ledger.length = 0
      open = null
      inflight = null
      tail = Promise.resolve()
      snapshotAt = null
    },
  }
  return owner
}

export function membershipValue(row: Record<string, unknown>): Record<string, unknown> {
  return {
    chat_id: String(row.chat_id),
    user_id: String(row.user_id),
    last_read_seq: Number(row.last_read_seq ?? 0),
    is_marked_unread: row.is_marked_unread === true,
    version: Number(row.version ?? 0),
    notification_level: (row.notification_level ?? 'all') as NotificationLevel,
    is_pinned: row.is_pinned === true,
    updated_at: String(row.updated_at ?? ''),
    joined_at: String(row.joined_at ?? row.updated_at ?? ''),
    inbox_published: row.inbox_published_at != null,
    role: typeof row.role === 'string' ? (row.role as GroupMemberRole) : null,
  }
}

/** 同一 chat 的多条 stream locator 合成一条(取最早那条的位置、累加计数)。 */
export function mergeUnreadRows(
  rows: Array<Record<string, unknown> & { chat_id: string }>,
): Map<string, ChatUnreadLocator & { chat_id: string }> {
  const byChat = new Map<string, ChatUnreadLocator & { chat_id: string }>()
  for (const row of rows) {
    const locator = {
      chat_id: row.chat_id,
      stream_id: String(row.stream_id),
      stream_kind: row.stream_kind === 'thread' ? 'thread' as const : 'main' as const,
      thread_root_id: typeof row.thread_root_id === 'string' ? row.thread_root_id : null,
      message_id: typeof row.message_id === 'string' ? row.message_id : null,
      message_seq: Number.isFinite(Number(row.message_seq)) ? Number(row.message_seq) : null,
      unread_count: Number(row.unread_count),
      addressed_count: addressedCount(row),
      cursor_seq: Number(row.cursor_seq),
      version: Number(row.version),
      is_marked_unread: row.is_marked_unread === true,
    }
    const previous = byChat.get(row.chat_id)
    if (!previous) { byChat.set(row.chat_id, locator); continue }
    const first = (locator.message_seq ?? Number.MAX_SAFE_INTEGER) < (previous.message_seq ?? Number.MAX_SAFE_INTEGER)
      ? locator : previous
    byChat.set(row.chat_id, { ...first, unread_count: previous.unread_count + locator.unread_count, addressed_count: previous.addressed_count + locator.addressed_count })
  }
  return byChat
}

/** addressed_count 是 list_unread_locators 的必有列(gugu-supabase#73):缺了或不是数 = 协议错误,大声失败。 */
function addressedCount(row: Record<string, unknown>): number {
  const value = typeof row.addressed_count === 'string' ? Number(row.addressed_count) : row.addressed_count
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`list_unread_locators row for ${String(row.chat_id)} has no addressed_count`)
  }
  return value
}

/** 请求过的键一律落位:读到 = 值,没读到 = null(tombstone,spec I3)。 */
function indexBy<T>(ids: readonly string[], rows: readonly T[], id: (row: T) => string): Map<string, unknown> {
  const byId = new Map<string, unknown>()
  for (const row of rows) byId.set(id(row), row)
  return indexExact(ids, byId)
}

function indexExact(ids: readonly string[], byId: Map<string, unknown>): Map<string, unknown> {
  return new Map([...ids].map((id) => [id, byId.get(id) ?? null]))
}

/**
 * 广播里的 revision。⚠️ `jsonb_build_object('revision', …)` 让 BIGINT 变成 JSON **number**,
 * 而 revision 穿边界必须是十进制字符串(realtime-catchup 的既有不变量)。
 * 所以:字符串直接用;number 只在**安全整数**范围内接受,越界即视为「head 未知」,
 * 退回补拉 —— ❌ 不静默截断精度。服务端改成发字符串后这一支自然消失。
 */
export function parseWakeHead(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const revision = (payload as { revision?: unknown }).revision
  if (typeof revision === 'string' && /^(0|[1-9]\d*)$/.test(revision)) return revision
  if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) return String(revision)
  return null
}

export { splitKey }
