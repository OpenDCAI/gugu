import type {
  ChatItem,
  GroupAgentItem,
  GroupCollabSnapshot,
  GroupMemberItem,
  GroupSchedulerState,
  MessageItem,
} from '@gugu/core/shared/types/chat'
import { displayIdentityFromRow, type DisplayIdentity } from './displayIdentity'
import { recordImTransaction } from './perfCounters'
import { assertIdentityClosure } from './identityClosure'
import { resolveListenModeDefault } from '@gugu/core/cloud/listenMode'
import { rendererLogger } from './log'
import {
  IM_STORE_NAMES,
  LocalImCacheError,
  migrateLegacyChatList,
  openLocalSyncDb,
  type ImStoreName,
  type LocalImDbAdapter,
  type LocalImDbOperation,
  type LocalImRow,
} from './localSyncDb'

type EntityValue = Record<string, unknown>
const repositoryLog = rendererLogger('im/repository')

export type IdentityRow = LocalImRow & { id: string; value: DisplayIdentity }
export type ChatRow = LocalImRow & { id: string; order: number; value: ChatItem }
export type MembershipRow = LocalImRow & { chatId: string; identityId: string; value: EntityValue }
export type MessageRow = LocalImRow & {
  id: string
  chatId: string
  streamId: string
  seq: number
  value: MessageItem
}
export type StreamRow = LocalImRow & {
  id: string
  chatId: string
  kind: 'main' | 'thread'
  rootMessageId: string | null
}
export type PresenceRow = LocalImRow & { identityId: string; value: EntityValue }
export type OutboxRow = LocalImRow & { id: string; value: OutboxRecord }
export type ViewRow = LocalImRow & { key: string; value: unknown }
export type SyncStateRow = LocalImRow & { key: string; value: unknown }

export interface OutboxRecord {
  clientMessageId: string
  chatId: string
  senderUserId: string
  payload: {
    content: string
    contentType: string
    toUserIds: string[] | null
    replyToMessageId: string | null
    threadRootId: string | null
    isThreadRoot: boolean
    isWhisper: boolean
    /** 私聊发送时对端尚未就绪:投递前由 outbox 的 prepare 解析对端并写回 toUserIds(#1554,C2)。 */
    resolveDmPeer?: boolean
  }
  state: 'pending' | 'sending' | 'failed'
  attempts: number
  lastError: string | null
  enqueuedAt: string
  updatedAt: string
}

export interface ImRepositorySnapshot {
  identity: readonly IdentityRow[]
  chat: readonly ChatRow[]
  membership: readonly MembershipRow[]
  message: readonly MessageRow[]
  stream: readonly StreamRow[]
  presence: readonly PresenceRow[]
  outbox: readonly OutboxRow[]
  view: readonly ViewRow[]
  sync_state: readonly SyncStateRow[]
}

type MutableSnapshot = { [Store in ImStoreName]: LocalImRow[] }
type Selector<T> = (snapshot: ImRepositorySnapshot) => T
type Listener<T> = (value: T, snapshot: ImRepositorySnapshot) => void

export interface ImRepositoryTransaction {
  clear(): void
  putIdentity(value: unknown): void
  putChat(id: string, value: ChatItem, order?: number): void
  putMembership(chatId: string, identityId: string, value: EntityValue): void
  putMessage(value: MessageItem): void
  putStream(id: string, chatId: string, kind: 'main' | 'thread', rootMessageId?: string | null): void
  putPresence(identityId: string, value: EntityValue): void
  putOutbox(value: OutboxRecord): void
  putView(key: string, value: unknown): void
  putSyncState(key: string, value: unknown): void
  delete(store: ImStoreName, key: IDBValidKey): void
}

export interface AccountImRepository {
  readonly accountId: string
  snapshot(): ImRepositorySnapshot
  transaction<T>(mutate: (transaction: ImRepositoryTransaction) => T | Promise<T>): Promise<T>
  putIdentities(rows: readonly unknown[]): Promise<void>
  /**
   * This device's unpublished name for an identity it owns (an offline task rename). While held, every identity
   * write keeps it, so a cloud read that still carries the old name cannot undo it; `null` releases it once published.
   */
  holdIdentityName(id: string, displayName: string | null): void
  subscribe<T>(selector: Selector<T>, listener: Listener<T>): () => void
  reset(): Promise<void>
  close(): void
}

/**
 * @@@table-selector — 只读一张表的选择器:那张表还是上一次那个对象(这次事务没碰它,见 applyOperations),就交回上一次的结果。
 * 每次事务都会把每个订阅的选择器跑一遍;从前这里每次都新建一份身份表 / 会话列表,任何一次写(同步游标、一条消息)都让
 * 订阅身份或会话列表的每个组件整页重渲染 —— 藏着的通讯录随之每秒重画几百行(Chole 10-20 实测,渲染进程内存一路涨)。
 */
function fromTable<S extends ImStoreName, T>(store: S, derive: (rows: ImRepositorySnapshot[S]) => T): Selector<T> {
  let rows: ImRepositorySnapshot[S] | undefined
  let result: T
  return (snapshot) => {
    if (snapshot[store] !== rows) {
      rows = snapshot[store]
      result = derive(rows)
    }
    return result
  }
}

export const imSelectors = {
  identitiesById: fromTable('identity', (rows) => Object.freeze(Object.fromEntries(
    rows.map((row) => [row.id, row.value]),
  )) as Readonly<Record<string, DisplayIdentity>>),
  chats: fromTable('chat', (rows) => rows
    .slice()
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((row) => row.value)),
  membershipsForChat: (chatId: string) => fromTable('membership', (rows) =>
    rows.filter((row) => row.chatId === chatId)),
  messagesForChat: (chatId: string) => fromTable('message', (rows) => rows
    .filter((row) => row.chatId === chatId)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map((row) => row.value)),
  messagesForStream: (streamId: string) => fromTable('message', (rows) => rows
    .filter((row) => row.streamId === streamId)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map((row) => row.value)),
  presence: (snapshot: ImRepositorySnapshot) => snapshot.presence,
  outbox: (snapshot: ImRepositorySnapshot) => snapshot.outbox
    .map((row) => row.value)
    .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt)),
  view: (key: string) => (snapshot: ImRepositorySnapshot) => snapshot.view.find((row) => row.key === key)?.value,
  syncState: (key: string) => (snapshot: ImRepositorySnapshot) => snapshot.sync_state.find((row) => row.key === key)?.value,
}

export async function openImRepository(
  accountId: string,
  options: { adapter?: LocalImDbAdapter; storage?: Storage; initialize?: (repository: AccountImRepository) => Promise<void> } = {},
): Promise<AccountImRepository> {
  assertId(accountId, 'accountId')
  const adapter = options.adapter ?? await openLocalSyncDb()
  try {
    if (!options.initialize) {
      if (options.storage !== undefined) await migrateLegacyChatList(adapter, accountId, options.storage)
      else if (typeof window !== 'undefined') await migrateLegacyChatList(adapter, accountId)
    }
    let initial: Record<ImStoreName, LocalImRow[]>
    try {
      initial = await adapter.loadAccount(accountId)
    } catch (error) {
      if (!(error instanceof LocalImCacheError) || !options.initialize) throw error
      repositoryLog.warn({ accountId, error }, 'rebuilding invalid local IM cache')
      initial = Object.fromEntries(IM_STORE_NAMES.map((name) => [name, name === 'outbox' ? error.outbox : []])) as Record<ImStoreName, LocalImRow[]>
    }
    const repository = createAccountRepository(accountId, adapter, initial, options.adapter === undefined)
    await options.initialize?.(repository)
    return repository
  } catch (error) {
    if (options.adapter === undefined) adapter.close()
    throw error
  }
}

function createAccountRepository(
  accountId: string,
  adapter: LocalImDbAdapter,
  initial: Record<ImStoreName, LocalImRow[]>,
  ownsAdapter: boolean,
): AccountImRepository {
  let current = freezeSnapshot(initial)
  let closed = false
  let writeChain = Promise.resolve()
  const subscriptions = new Set<{ selector: Selector<unknown>; listener: Listener<unknown> }>()
  const heldNames = new Map<string, string>()

  const ensureOpen = () => {
    if (closed) throw new Error(`IM repository scope ${accountId} is closed`)
  }
  const notify = (subscription: { selector: Selector<unknown>; listener: Listener<unknown> }) => {
    try {
      subscription.listener(subscription.selector(current), current)
    } catch (error) {
      repositoryLog.error({ error }, 'subscriber failed')
    }
  }
  const publish = () => { for (const subscription of subscriptions) notify(subscription) }

  return {
    accountId,
    snapshot() {
      ensureOpen()
      return current
    },
    transaction(mutate) {
      ensureOpen()
      const run = writeChain.then(async () => {
        recordImTransaction()
        const operations: LocalImDbOperation[] = []
        const transaction = createTransaction(accountId, operations, heldNames)
        const result = await mutate(transaction)
        validateOperations(accountId, operations)
        const applied = applyOperations(current, operations, accountId)
        await adapter.commit(applied.operations)
        current = applied.snapshot
        publish()
        return result
      })
      writeChain = run.then(() => undefined, () => undefined)
      return run
    },
    putIdentities(rows) {
      return this.transaction((transaction) => { for (const row of rows) transaction.putIdentity(row) })
    },
    holdIdentityName(id, displayName) {
      if (displayName?.trim()) heldNames.set(id, displayName.trim())
      else heldNames.delete(id)
    },
    subscribe<T>(selector: Selector<T>, listener: Listener<T>) {
      ensureOpen()
      const subscription = { selector: selector as Selector<unknown>, listener: listener as Listener<unknown> }
      subscriptions.add(subscription)
      notify(subscription)
      return () => { subscriptions.delete(subscription) }
    },
    reset() {
      ensureOpen()
      const run = writeChain.then(async () => {
        await adapter.commit([{ type: 'clearAccount', accountId }])
        current = emptySnapshot()
        publish()
      })
      writeChain = run.then(() => undefined, () => undefined)
      return run
    },
    close() {
      if (closed) return
      closed = true
      subscriptions.clear()
      if (ownsAdapter) void writeChain.finally(() => adapter.close())
    },
  }
}

function createTransaction(
  accountId: string,
  operations: LocalImDbOperation[],
  heldNames: ReadonlyMap<string, string>,
): ImRepositoryTransaction {
  const put = (store: ImStoreName, value: LocalImRow) => operations.push({ type: 'put', store, value })
  return {
    clear: () => operations.push({ type: 'clearAccount', accountId }),
    putIdentity: (value) => {
      const parsed = displayIdentityFromRow(value)
      const held = heldNames.get(parsed.id)
      const identity = held ? { ...parsed, display_name: held } : parsed
      put('identity', { accountId, id: identity.id, value: identity })
    },
    putChat: (id, value, order = 0) => put('chat', { accountId, id: nonEmpty(id, 'chat.id'), order, value }),
    putMembership: (chatId, identityId, value) => put('membership', {
      accountId,
      chatId: nonEmpty(chatId, 'membership.chatId'),
      identityId: nonEmpty(identityId, 'membership.identityId'),
      value,
    }),
    putMessage(value) {
      const chatId = nonEmpty(value.chat_id, 'message.chatId')
      const root = value.thread_root_id ?? null
      const streamId = messageStreamId(value)
      put('stream', { accountId, id: streamId, chatId, kind: root ? 'thread' : 'main', rootMessageId: root })
      put('message', { accountId, id: nonEmpty(value.id, 'message.id'), chatId, streamId, seq: value.seq, value })
    },
    putStream: (id, chatId, kind, rootMessageId = null) => put('stream', {
      accountId,
      id: nonEmpty(id, 'stream.id'),
      chatId: nonEmpty(chatId, 'stream.chatId'),
      kind,
      rootMessageId,
    }),
    putPresence: (identityId, value) => put('presence', {
      accountId,
      identityId: nonEmpty(identityId, 'presence.identityId'),
      value,
    }),
    putOutbox(value) {
      validateOutbox(value, accountId)
      put('outbox', { accountId, id: value.clientMessageId, value })
    },
    putView: (key, value) => put('view', { accountId, key: nonEmpty(key, 'view.key'), value }),
    putSyncState: (key, value) => put('sync_state', { accountId, key: nonEmpty(key, 'sync_state.key'), value }),
    delete: (store, key) => operations.push({ type: 'delete', store, key }),
  }
}

export async function replaceChatRows(repository: AccountImRepository, chats: ChatItem[]): Promise<void> {
  await repository.transaction((transaction) => {
    writeChatRows(repository, transaction, chats)
  })
}

export function writeChatRows(repository: AccountImRepository, transaction: ImRepositoryTransaction, chats: ChatItem[]): void {
  const ids = new Set(chats.map((chat) => chat.id))
  for (const row of repository.snapshot().chat) {
    if (!ids.has(row.id)) transaction.delete('chat', [repository.accountId, row.id])
  }
  chats.forEach((chat, order) => {
    const { read_state_version: _discarded, ...projection } = chat
    transaction.putChat(chat.id, projection as ChatItem, order)
  })
}

/** Publish the conversation list with the identities it needs as one snapshot. */
export async function replaceChatRowsAndIdentities(
  repository: AccountImRepository,
  chats: ChatItem[],
  identities: readonly unknown[],
): Promise<void> {
  const published = chats
  // 行引用的每个 id(对端 / 群成员)都必须在这一次提交的身份里 —— 忘了在这里报,不在冷启动时整份缓存作废。
  assertIdentityClosure('conversation list', published.flatMap((chat) => [chat.peer_user_id, ...(chat.member_user_ids ?? [])]), identities)
  await repository.transaction((transaction) => {
    writeChatRows(repository, transaction, published)
    for (const identity of identities) transaction.putIdentity(identity)
  })
}

export function readChatRows(repository: AccountImRepository): ChatItem[] {
  return imSelectors.chats(repository.snapshot())
}

export interface CachedMessageWindow {
  messages: MessageItem[]
  oldestSeq: number
  maxSeq: number
  hasMoreOlder: boolean
}

export async function replaceMessageWindow(
  repository: AccountImRepository,
  chatId: string,
  messages: MessageItem[],
  hasMoreOlder = false,
): Promise<void> {
  await repository.transaction((transaction) => {
    const persisted = messages.filter((message) => message.chat_id === chatId && message.seq >= 0)
    const ids = new Set(persisted.map((message) => message.id))
    const streamIds = new Set(persisted.map(messageStreamId))
    for (const row of repository.snapshot().message) {
      if (row.chatId === chatId && !ids.has(row.id)) transaction.delete('message', [repository.accountId, row.id])
    }
    for (const row of repository.snapshot().stream) {
      if (row.chatId === chatId && !streamIds.has(row.id)) transaction.delete('stream', [repository.accountId, row.id])
    }
    for (const message of persisted) transaction.putMessage(message)
    transaction.putView(`message-window:${chatId}`, {
      oldestSeq: persisted.length > 0 ? Math.min(...persisted.map((message) => message.seq)) : 0,
      maxSeq: persisted.length > 0 ? Math.max(...persisted.map((message) => message.seq)) : 0,
      hasMoreOlder,
    })
  })
}

function messageStreamId(message: MessageItem): string {
  return message.thread_root_id ? `thread:${message.chat_id}:${message.thread_root_id}` : `main:${message.chat_id}`
}

export function readMessageWindow(repository: AccountImRepository, chatId: string): CachedMessageWindow | null {
  const messages = imSelectors.messagesForStream(`main:${chatId}`)(repository.snapshot())
  const cursor = imSelectors.view(`message-window:${chatId}`)(repository.snapshot()) as Omit<CachedMessageWindow, 'messages'> | undefined
  if (messages.length === 0 && !cursor) return null
  const seqs = messages.map((message) => message.seq)
  return {
    messages,
    oldestSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
    maxSeq: seqs.length > 0 ? Math.max(...seqs) : 0,
    hasMoreOlder: cursor?.hasMoreOlder ?? false,
  }
}

/** Publish a group roster with the identities it needs as one snapshot. */
export async function replaceGroupRoster(
  repository: AccountImRepository,
  chatId: string,
  snapshot: GroupCollabSnapshot,
  identities: readonly unknown[],
): Promise<void> {
  const members = [...snapshot.humans, ...snapshot.agents]
  // 名册里的每个成员都必须带身份;被删除的 agent(account_status 'removed')是墓碑,按定义没有身份行,读侧会剪掉。
  assertIdentityClosure(`group roster ${chatId}`, members.filter((member) => member.account_status !== 'removed').map((member) => member.id), identities)
  await repository.transaction((transaction) => {
    for (const row of repository.snapshot().membership) {
      if (row.chatId === chatId) transaction.delete('membership', [repository.accountId, chatId, row.identityId])
    }
    for (const member of members) {
      transaction.putMembership(chatId, member.id, {
        role: member.role,
        type: member.type,
        account_status: member.account_status,
        listen_mode: member.type === 'agent' ? (member as GroupAgentItem).listen_mode : null,
      })
    }
    // 成员行和它们的身份写在同一个事务里 —— 与 replaceChatRowsAndIdentities 同构。分开写就会有一段
    // 「行已落库、身份还没有」的窗口,而那段窗口正是下游拿空名字当 @ 匹配 key 的时机。
    // 名册在 agent 运行期间按 300ms 合并一次地反复刷新,身份多半没变:与已落库的值相同的行不再 put,
    // 省的是每行的 zod 解析、structuredClone 与 IndexedDB 写(订阅者通知不省 —— 事务提交后一律 publish)。
    const stored = new Map(repository.snapshot().identity.map((row) => [row.id, row.value]))
    for (const identity of identities) {
      const id = (identity as { id?: unknown }).id
      const current = typeof id === 'string' ? stored.get(id) : undefined
      if (current !== undefined && JSON.stringify(current) === JSON.stringify(identity)) continue
      transaction.putIdentity(identity)
    }
  })
}

/**
 * 名册里「身份缺席的活跃成员」不进本地库:getGroupCollab 对 identity.users 缺行的成员是**有意保留**的(记
 * [resolve-fail #1624] 日志、类型按 human),内存名册照显、本地持久化却会被 replaceGroupRoster 的闭包断言整份
 * 拒掉 —— 那条断言是给「调用方忘了交身份」的 tripwire,不该由它来替上游的数据缺口做决定。所以由调用方在这里
 * **明确地**剪掉这些成员再写:剪掉了谁在日志里可查,与冷启动投影(assemble 只带有身份的成员)是同一条规则。
 * 被删除的 agent(account_status 'removed')是墓碑、按定义没有身份行,原样保留。
 */
export function persistableGroupRoster(chatId: string, snapshot: GroupCollabSnapshot, identities: readonly unknown[]): GroupCollabSnapshot {
  const present = new Set<string>()
  for (const identity of identities) {
    const id = (identity as { id?: unknown } | null)?.id
    if (typeof id === 'string') present.add(id)
  }
  const keep = (member: GroupMemberItem | GroupAgentItem) => present.has(member.id) || member.account_status === 'removed'
  const dropped = [...snapshot.humans, ...snapshot.agents].filter((member) => !keep(member)).map((member) => member.id)
  if (dropped.length === 0) return snapshot
  repositoryLog.warn({ chatId, dropped }, 'group roster members without identity are not persisted locally')
  return { ...snapshot, humans: snapshot.humans.filter(keep), agents: snapshot.agents.filter(keep) }
}

export function readGroupRoster(repository: AccountImRepository, chatId: string): GroupCollabSnapshot | null {
  const snapshot = repository.snapshot()
  const memberships = snapshot.membership.filter((row) => row.chatId === chatId)
  if (memberships.length === 0) return null
  const humans: GroupMemberItem[] = []
  const agents: GroupAgentItem[] = []
  for (const membership of memberships) {
    const member = membership.value
    const base: GroupMemberItem = {
      id: membership.identityId,
      role: member.role as GroupMemberItem['role'],
      type: member.type as GroupMemberItem['type'],
      account_status: member.account_status as GroupMemberItem['account_status'],
    }
    if (base.type === 'agent') {
      agents.push({
        ...base,
        type: 'agent',
        client: null,
        model_source: null,
        tools: [],
        permission_scope: null,
        current_task_id: null,
        current_task_title: null,
        last_action: null,
        last_active_at: null,
        // @@@5856 ❗ 不走裸 cast:本机缓存里还躺着升级前写的 'adaptive'。裸 cast 会让它成为
        // 一个被当成 ListenMode 用的非法值 ⇒ 成员面板 SWR 首帧的档位开关读错这些 agent,
        // 直到权威快照合并回来。跟 resolveListenModeDefault 用同一把尺。
        listen_mode: resolveListenModeDefault(typeof member.listen_mode === 'string' ? member.listen_mode : null),
      })
    } else humans.push(base)
  }
  return { scheduler: emptyScheduler(chatId), humans, agents, tasks: [], outputs: [] }
}

export function readOutboxRecords(repository: AccountImRepository): OutboxRecord[] {
  return imSelectors.outbox(repository.snapshot())
}

export async function putOutboxRecord(repository: AccountImRepository, record: OutboxRecord): Promise<void> {
  await repository.transaction((transaction) => transaction.putOutbox(record))
}

export async function deleteOutboxRecord(repository: AccountImRepository, clientMessageId: string): Promise<void> {
  await repository.transaction((transaction) => transaction.delete('outbox', [repository.accountId, clientMessageId]))
}

export async function ackOutboxRecord(
  repository: AccountImRepository,
  clientMessageId: string,
  message: MessageItem,
): Promise<void> {
  if (message.id !== clientMessageId) throw new Error(`outbox ack id mismatch: ${clientMessageId} != ${message.id}`)
  const viewKey = `message-window:${message.chat_id}`
  await repository.transaction((transaction) => {
    const snapshot = repository.snapshot()
    const cursor = imSelectors.view(viewKey)(snapshot) as Omit<CachedMessageWindow, 'messages'> | undefined
    const mainSeqs = message.thread_root_id || !cursor ? [] : snapshot.message
      .filter((row) => row.streamId === `main:${message.chat_id}`)
      .map((row) => row.seq).concat(message.seq)
    transaction.putMessage(message)
    transaction.delete('outbox', [repository.accountId, clientMessageId])
    if (cursor && mainSeqs.length > 0) transaction.putView(viewKey, {
      ...cursor, oldestSeq: Math.min(...mainSeqs), maxSeq: Math.max(...mainSeqs),
    })
  })
}

function emptyScheduler(chatId: string): GroupSchedulerState {
  return {
    chat_id: chatId,
    paused: false,
    queue_count: 0,
    blocked_count: 0,
    summary: null,
    updated_at: new Date(0).toISOString(),
  }
}

function validateOutbox(record: OutboxRecord, accountId: string): void {
  if (record.senderUserId !== accountId) throw new Error(`outbox account mismatch: ${record.senderUserId} != ${accountId}`)
  nonEmpty(record.clientMessageId, 'outbox.clientMessageId')
  nonEmpty(record.chatId, 'outbox.chatId')
  if (!record.payload
    || typeof record.payload.content !== 'string'
    || typeof record.payload.contentType !== 'string'
    || (record.payload.toUserIds !== null && (!Array.isArray(record.payload.toUserIds) || record.payload.toUserIds.some((id) => !id)))
    || (record.payload.replyToMessageId !== null && typeof record.payload.replyToMessageId !== 'string')
    || (record.payload.threadRootId !== null && typeof record.payload.threadRootId !== 'string')
    || typeof record.payload.isThreadRoot !== 'boolean'
    || typeof record.payload.isWhisper !== 'boolean'
    || (record.payload.resolveDmPeer !== undefined && typeof record.payload.resolveDmPeer !== 'boolean')) {
    throw new Error('outbox payload is invalid')
  }
}

function validateOperations(accountId: string, operations: readonly LocalImDbOperation[]): void {
  for (const operation of operations) {
    if (operation.type === 'put' && operation.value.accountId !== accountId) {
      throw new Error(`repository transaction crossed account boundary: ${operation.value.accountId} != ${accountId}`)
    }
    if (operation.type === 'clearAccount' && operation.accountId !== accountId) {
      throw new Error(`repository reset crossed account boundary: ${operation.accountId} != ${accountId}`)
    }
    if (operation.type === 'delete') {
      const keyAccount = Array.isArray(operation.key) ? operation.key[0] : null
      if (keyAccount !== accountId) {
        throw new Error(`repository delete crossed account boundary: ${String(keyAccount)} != ${accountId}`)
      }
    }
  }
}

function applyOperations(
  snapshot: ImRepositorySnapshot,
  operations: readonly LocalImDbOperation[],
  accountId: string,
): { snapshot: ImRepositorySnapshot; operations: LocalImDbOperation[] } {
  // 每张碰到的表按主键建一次索引,一次事务里的写都落在它上面。真改了的表才换成新数组;没碰到、或只是把一行原样再写
  // 一遍的表(每次刷会话列表都会把全部身份再写一遍)还是原来那个对象 —— @@@table-selector 靠它认出「没变」。
  // 从前每写一行都按 JSON 比一遍整张表,身份表每刷一次就是 行数² 次序列化。
  const next = { ...snapshot } as unknown as MutableSnapshot
  const edits = new Map<ImStoreName, Map<string, LocalImRow>>()
  const changed = new Set<ImStoreName>()
  const effective: LocalImDbOperation[] = []
  const rowsOf = (store: ImStoreName) => {
    let rows = edits.get(store)
    if (!rows) {
      rows = new Map(next[store].map((row) => [JSON.stringify(keyForRow(store, row)), row]))
      edits.set(store, rows)
    }
    return rows
  }
  for (const operation of operations) {
    if (operation.type === 'clearAccount') {
      for (const store of IM_STORE_NAMES) {
        edits.set(store, new Map())
        changed.add(store)
      }
      effective.push(operation)
      continue
    }
    const rows = rowsOf(operation.store)
    const key = JSON.stringify(operation.type === 'put' ? keyForRow(operation.store, operation.value) : operation.key)
    if (operation.type === 'put') {
      const existing = rows.get(key)
      if (existing && JSON.stringify(existing) === JSON.stringify(operation.value)) continue
      rows.set(key, structuredClone(operation.value))
      changed.add(operation.store)
      effective.push({ ...operation, value: rows.get(key)! })
    } else if (rows.delete(key)) {
      changed.add(operation.store)
      effective.push(operation)
    }
  }
  for (const store of changed) {
    next[store] = [...edits.get(store)!.values()]
    if (next[store].some((row) => row.accountId !== accountId)) throw new Error(`snapshot ${store} crossed account boundary`)
  }
  // Prepare with the existing row comparison before persistence; publish only after this batch commits.
  return { snapshot: freezeSnapshot(next), operations: effective }
}

function keyForRow(store: ImStoreName, row: LocalImRow): IDBValidKey {
  const value = row as Record<string, unknown>
  if (store === 'membership') return [value.accountId as string, value.chatId as string, value.identityId as string]
  if (store === 'presence') return [value.accountId as string, value.identityId as string]
  if (store === 'view' || store === 'sync_state') return [value.accountId as string, value.key as string]
  return [value.accountId as string, value.id as string]
}

function freezeSnapshot(rows: Record<ImStoreName, LocalImRow[]>): ImRepositorySnapshot {
  return deepFreeze(Object.fromEntries(IM_STORE_NAMES.map((store) => [store, rows[store]]))) as unknown as ImRepositorySnapshot
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  // 冻过的就是这里整棵冻过的(上一份快照留下的表与行):不再走一遍。
  if (typeof value !== 'object' || value === null || seen.has(value) || Object.isFrozen(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen)
  return Object.freeze(value)
}

function emptySnapshot(): ImRepositorySnapshot {
  return freezeSnapshot(Object.fromEntries(IM_STORE_NAMES.map((store) => [store, []])) as unknown as Record<ImStoreName, LocalImRow[]>)
}

function nonEmpty(value: string, label: string): string {
  if (!value) throw new Error(`${label} must be a non-empty string`)
  return value
}

function assertId(value: string, label: string): void {
  nonEmpty(value, label)
}
