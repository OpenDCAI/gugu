import { replaceEqualDeep } from '@tanstack/react-query'
import { memoizeByReference } from './memoizeByReference'
import type { CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import type { CreateTopicInput } from './topics'
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
import { initializeMessages, ingestMessages } from './messageIngest'
import { platform } from '../platform'
import { compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import { MAX_WINDOW } from '../store/chatMessageWindow'
import {
  IM_STORE_NAMES,
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
export type ChatRow = LocalImRow & { id: string; value: ChatItem }
type ChatRowChanges = { changed: readonly ChatItem[]; deleted: readonly string[] }
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

export type OutboxOperation =
  | { kind: 'message' }
  | { kind: 'upload' }
  | { kind: 'nativeAttachment'; commit: Omit<CommitArgs, 'staging_key'> }
  | { kind: 'forward'; source: { kind: 'message'; id: string } | { kind: 'file'; id: string; version: number | null } }
  | { kind: 'attachment'; commit: CommitArgs }
  | { kind: 'topic'; input: CreateTopicInput & { topicId: string } }

export interface OutboxRecord {
  /** Missing on older durable text records. */
  operation?: OutboxOperation
  preview?: Pick<MessageItem, 'file_item_id' | 'file_version' | 'file_blob_id' | 'file_metadata' | 'image_dimensions'>
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
  /** Local source dependency, preserved across restarts. */
  dependsOn?: string
  dependencyDiscarded?: boolean
  state: 'pending' | 'sending' | 'failed' | 'uploading'
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
  putChat(id: string, value: ChatItem): void
  putMembership(chatId: string, identityId: string, value: EntityValue): void
  putMessage(value: MessageItem): void
  readView(key: string): unknown
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
  const project = memoizeByReference(derive)
  return snapshot => project(snapshot[store], undefined)
}

export const imSelectors = {
  identitiesById: fromTable('identity', (rows) => Object.freeze(Object.fromEntries(
    rows.map((row) => [row.id, row.value]),
  )) as Readonly<Record<string, DisplayIdentity>>),
  // List order is the projection's (activity, then id); it is sorted here, on a read, not stored per row — a stored
  // position would make one moved conversation rewrite every row below it.
  chats: fromTable('chat', (rows) => rows
    .map((row) => row.value)
    .sort((a, b) => compareChatsByActivityDesc(a, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
  chatRowsById: fromTable('chat', (rows) => new Map(rows.map(row => [row.id, row.value]))),
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
  options: {
    adapter?: LocalImDbAdapter; storage?: Storage; initialize?: (repository: AccountImRepository) => Promise<void>
    /** Local rows are readable: the first frame. `initialize` (which may wait on the network) runs after it. */
    loaded?: (repository: AccountImRepository) => void
  } = {},
): Promise<AccountImRepository> {
  assertId(accountId, 'accountId')
  const adapter = options.adapter ?? await openLocalSyncDb()
  try {
    await initializeMessages(accountId, adapter)
    if (!options.initialize) {
      if (options.storage !== undefined) await migrateLegacyChatList(adapter, accountId, options.storage)
      else if (typeof window !== 'undefined') await migrateLegacyChatList(adapter, accountId)
    }
    const repository = createAccountRepository(accountId, adapter, await adapter.loadAccount(accountId), options.adapter === undefined)
    options.loaded?.(repository)
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
  for (const store of IM_STORE_NAMES) {
    if (initial[store].some(row => row.accountId !== accountId)) throw new Error(`snapshot ${store} crossed account boundary`)
  }
  let current = freezeSnapshot(initial)
  let closed = false
  let writeChain = Promise.resolve()
  const subscriptions = new Set<{ selector: Selector<unknown>; listener: Listener<unknown> }>()

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
        const transaction = createTransaction(accountId, operations, current)
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

function createTransaction(accountId: string, operations: LocalImDbOperation[], stored: ImRepositorySnapshot): ImRepositoryTransaction {
  const put = (store: ImStoreName, value: LocalImRow) => operations.push({ type: 'put', store, value })
  const readView = (key: string): unknown => {
    for (let index = operations.length - 1; index >= 0; index -= 1) {
      const operation = operations[index]!
      if (operation.type === 'clearAccount') return undefined
      if (operation.type === 'put' && operation.store === 'view' && operation.value.key === key) return operation.value.value
      if (operation.type === 'delete' && operation.store === 'view' && Array.isArray(operation.key) && operation.key[1] === key) return undefined
    }
    return imSelectors.view(key)(stored)
  }
  const removed = new Set<string>()
  const identityWrites = new Set<string>()
  let cleared = false
  return {
    clear: () => { cleared = true; operations.push({ type: 'clearAccount', accountId }) },
    putIdentity: (value) => {
      const id = value && typeof value === 'object' && 'id' in value ? value.id : undefined
      const previous = typeof id === 'string' ? imSelectors.identitiesById(stored)[id] : undefined
      if (previous && !cleared && !identityWrites.has(previous.id) && replaceEqualDeep(previous, value) === previous) return
      // An identity the projection already parsed is kept as that object (parsing it again only makes an equal
      // copy, see @@@one-row-object); a raw row becomes its parsed form.
      const parsed = displayIdentityFromRow(value)
      const identity = replaceEqualDeep(value, parsed) === value ? value as DisplayIdentity : parsed
      // Removal is terminal on the server (a removed identity is immutable), so a row without
      // removed_at is an older observation and cannot bring a removed identity back.
      if (!identity.removed_at && (previous?.removed_at || removed.has(identity.id))) return
      if (identity.removed_at) removed.add(identity.id)
      identityWrites.add(identity.id)
      put('identity', { accountId, id: identity.id, value: identity })
    },
    putChat: (id, value) => put('chat', { accountId, id: nonEmpty(id, 'chat.id'), value }),
    putMembership: (chatId, identityId, value) => put('membership', {
      accountId,
      chatId: nonEmpty(chatId, 'membership.chatId'),
      identityId: nonEmpty(identityId, 'membership.identityId'),
      value,
    }),
    putMessage(value) {
      if ((readView(`message-revision:${value.id}`) as { deleted?: boolean } | undefined)?.deleted) return
      const chatId = nonEmpty(value.chat_id, 'message.chatId')
      const root = value.thread_root_id ?? null
      const streamId = messageStreamId(value)
      put('stream', { accountId, id: streamId, chatId, kind: root ? 'thread' : 'main', rootMessageId: root })
      put('message', { accountId, id: nonEmpty(value.id, 'message.id'), chatId, streamId, seq: value.seq, value })
    },
    readView,
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
    delete: (store, key) => {
      if (store === 'identity' && Array.isArray(key) && typeof key[1] === 'string') identityWrites.add(key[1])
      operations.push({ type: 'delete', store, key })
    },
  }
}

export async function replaceChatRows(repository: AccountImRepository, chats: readonly ChatItem[]): Promise<void> {
  await repository.transaction((transaction) => {
    writeChatRows(repository, transaction, chats)
  })
}

// @@@one-row-object: the stored (durable-shaped) row → the list row it was written from. A list row that is still the
// object the stored row came from has not changed, so it is not written again (no copy, no JSON comparison) —
// the conversation list is handed over on every update, and only the rows that changed cost anything.
const storedFrom = new WeakMap<object, ChatItem>()

export function writeChatRows(repository: AccountImRepository, transaction: ImRepositoryTransaction, chats: readonly ChatItem[]): void {
  writeChatRowChanges(repository, transaction, diffChatRows(imSelectors.chatRowsById(repository.snapshot()), chats))
}

/** Reference comparisons only; parsing and durable copies belong to the changed rows. */
function diffChatRows(current: ReadonlyMap<string, ChatItem>, next: readonly ChatItem[]): ChatRowChanges {
  const ids = new Set<string>()
  const changed: ChatItem[] = []
  for (const row of next) {
    ids.add(row.id)
    const stored = current.get(row.id)
    if (stored !== row && (!stored || storedFrom.get(stored) !== row)) changed.push(row)
  }
  return { changed, deleted: [...current.keys()].filter(id => !ids.has(id)) }
}

function writeChatRowChanges(repository: AccountImRepository, transaction: ImRepositoryTransaction, changes: ChatRowChanges): void {
  for (const id of changes.deleted) transaction.delete('chat', [repository.accountId, id])
  for (const chat of changes.changed) {
    const { read_state_version: _discarded, ...projection } = chat
    storedFrom.set(projection, chat)
    transaction.putChat(chat.id, projection as ChatItem)
  }
}

/** Publish the conversation list with the identities it needs as one snapshot. */
export async function replaceChatRowsAndIdentities(
  repository: AccountImRepository,
  chats: readonly ChatItem[] | (() => readonly ChatItem[]),
  identities: readonly unknown[],
  isConversationDeleted?: (id: string) => boolean,
): Promise<void> {
  await repository.transaction((transaction) => {
    // Evaluate inside the serialized write: an older queued snapshot cannot undo a confirmed deletion.
    const changes = diffChatRows(imSelectors.chatRowsById(repository.snapshot()),
      (typeof chats === 'function' ? chats() : chats).filter(chat => !isConversationDeleted?.(chat.id)))
    for (const chat of changes.changed) {
      assertIdentityClosure('conversation list', chat.member_user_ids ?? [], identities)
      if (chat.peer_user_id) assertIdentityClosure('conversation list', [chat.peer_user_id], identities)
    }
    writeChatRowChanges(repository, transaction, changes)
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
  /** Event rows are paintable, but do not prove a contiguous tail. */
  sparse?: boolean
}

/**
 * Called inside the revision inbox/cursor transaction. On the phone the per-message version row doubles as the
 * notification claim: only the first commit that creates it wins. Desktop keeps no such row (@@@arrival-claim). The repository serializes
 * transactions and desktop runs one repository per account, so read-then-write here is atomic.
 */
export function ingestAccountMessage(repository: AccountImRepository, transaction: ImRepositoryTransaction,
  message: MessageItem, revision: string, arrived?: ReadonlySet<string>): { won: boolean } {
  // Desktop: the body is already in the local message store; whether this page stored it is the claim (@@@arrival-claim).
  // A recovered body (no page) was fetched and stored once by its own recovery.
  if (platform.localMessages === 'sqlite') return { won: arrived?.has(message.id) ?? true }
  const snapshot = repository.snapshot()
  const versionKey = `message-revision:${message.id}`
  const version = transaction.readView(versionKey) as { revision: string; deleted?: boolean } | undefined
  if (version && (version.deleted || BigInt(version.revision) >= BigInt(revision))) return { won: false }
  transaction.putView(versionKey, { revision })
  const previous = snapshot.message.find(row => row.id === message.id && row.streamId === messageStreamId(message))?.value
  transaction.putMessage(mergeMessagesById(previous ? [previous] : [], [message], message.chat_id)[0]!)
  if (!message.thread_root_id) {
    const key = `message-window:${message.chat_id}`
    const cursor = imSelectors.view(key)(snapshot) as Omit<CachedMessageWindow, 'messages'> | undefined
    // Final ranges and retention are derived once, from all writes in the page.
    transaction.putView(key, { oldestSeq: 0, maxSeq: 0,
      hasMoreOlder: cursor?.hasMoreOlder ?? message.seq > 1,
      sparse: !cursor || cursor.sparse === true || message.seq > cursor.maxSeq + 1 })
  }
  return { won: !version }
}

/** Deletion from the account feed. Desktop's local message store already holds the row removal and its tombstone. */
export function recordMessageDeletion(transaction: ImRepositoryTransaction, accountId: string, chatId: string | null, id: string, revision: string): void {
  if (platform.localMessages === 'sqlite') return
  transaction.delete('message', [accountId, id])
  transaction.putView(`message-revision:${id}`, { revision, deleted: true, chatId })
}

export async function replaceMessageWindow(
  repository: AccountImRepository,
  chatId: string,
  messages: MessageItem[],
  hasMoreOlder = false,
  /** null is a local write-through, not proof that a sparse tail was fetched. */
  verifiedTailSeq?: number | null,
): Promise<void> {
  if (platform.localMessages === 'sqlite') return // Desktop windows are read from the session SQLite store.
  await repository.transaction((transaction) => {
    // Account arrivals (message-revision rows): a late older window must neither drop nor revive them.
    const arrivals = new Map(repository.snapshot().view.filter(row => row.key.startsWith('message-revision:'))
      .map(row => [row.key.slice('message-revision:'.length), row.value as { deleted?: boolean }]))
    const fetched = messages.filter((message) => message.chat_id === chatId && message.seq >= 0 && !arrivals.get(message.id)?.deleted)
    const maxFetched = Math.max(0, ...fetched.map(message => message.seq))
    const coverageTail = verifiedTailSeq ?? maxFetched
    const sparse = (verifiedTailSeq === null
      && (imSelectors.view(`message-window:${chatId}`)(repository.snapshot()) as { sparse?: boolean } | undefined)?.sparse === true)
      || repository.snapshot().message.some(row => row.chatId === chatId && !row.value.thread_root_id
        && arrivals.has(row.id) && row.seq > coverageTail)
    const newer = imSelectors.messagesForChat(chatId)(repository.snapshot())
      .filter(message => arrivals.has(message.id) && (message.thread_root_id || message.seq > maxFetched))
    const persisted = mergeMessagesById(fetched, newer, chatId).slice(-MAX_WINDOW)
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
      ...(sparse ? { sparse: true } : {}),
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
    ...(cursor?.sparse ? { sparse: true } : !cursor ? { sparse: true } : {}),
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
    for (const identity of identities) transaction.putIdentity(identity)
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
  return { scheduler: emptyScheduler(chatId), humans, agents, tasks: [] }
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
  await ingestMessages(repository.accountId, { writes: [{ type: 'put', message }], revisions: [] })
  // applyOperations re-derives the cached window bounds from the committed main stream.
  await repository.transaction((transaction) => {
    if (platform.localMessages !== 'sqlite') transaction.putMessage(message)
    transaction.delete('outbox', [repository.accountId, clientMessageId])
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
      rows = new Map(tableIndex(store, next[store]))
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
      if (existing && JSON.stringify(existing) === JSON.stringify(operation.value)) {
        if (operation.store === 'chat') {
          const source = storedFrom.get(operation.value.value as object)
          if (source) storedFrom.set(existing.value as object, source)
        }
        continue
      }
      // @@@one-row-object: the snapshot holds the value it was handed (frozen below), not a clone of it — an identity
      // the projection read is then one object in both. Writers hand over values they no longer change.
      rows.set(key, operation.value)
      changed.add(operation.store)
      effective.push(operation)
    } else if (rows.delete(key)) {
      changed.add(operation.store)
      effective.push(operation)
    }
  }
  // Message writes re-derive each touched window's bounds from the committed main stream. Account
  // ingestion (it writes message-revision rows) also bounds every stream it touched, once per page.
  if (changed.has('message')) {
    const before = new Map(snapshot.message.map(row => [row.id, row]))
    const put = operations.flatMap(operation => operation.type === 'put' && operation.store === 'message' ? [operation.value] : [])
    const removed = operations.flatMap(operation => operation.type === 'delete' && operation.store === 'message' && Array.isArray(operation.key)
      ? [before.get(operation.key[1] as string)].filter(row => row !== undefined) : [])
    const stream = (id: string) => [...rowsOf('message').values()].filter(row => row.streamId === id).sort((a, b) => (b.seq as number) - (a.seq as number))
    const ingested = operations.some(operation => operation.type === 'put' && String(operation.value.key).startsWith('message-revision:'))
    for (const streamId of ingested ? new Set(put.map(row => row.streamId as string)) : []) {
      for (const row of stream(streamId).slice(MAX_WINDOW)) {
        const key = [accountId, row.id as string]
        rowsOf('message').delete(JSON.stringify(key))
        effective.push({ type: 'delete', store: 'message', key })
      }
    }
    for (const chatId of new Set([...put, ...removed].map(row => row.chatId as string))) {
      const key = `message-window:${chatId}`
      const row = rowsOf('view').get(JSON.stringify([accountId, key]))
      if (!row) continue
      const seqs = stream(`main:${chatId}`).map(row => row.seq as number)
      const value = { ...(row.value as object), oldestSeq: seqs.at(-1) ?? 0, maxSeq: seqs[0] ?? 0 }
      if (JSON.stringify(value) === JSON.stringify(row.value)) continue
      const nextRow = { ...row, value }
      rowsOf('view').set(JSON.stringify([accountId, key]), nextRow)
      changed.add('view')
      const pending = effective.findLast(operation => operation.type === 'put' && operation.store === 'view' && operation.value.key === key)
      if (pending?.type === 'put') pending.value = nextRow
      else effective.push({ type: 'put', store: 'view', value: nextRow })
    }
  }
  for (const store of changed) {
    next[store] = [...edits.get(store)!.values()]
    tableIndexes.set(next[store], edits.get(store)!)
  }
  // Prepare with the existing row comparison before persistence; publish only after this batch commits.
  return { snapshot: freezeSnapshot(next), operations: effective }
}

// A table's rows by key, built once per table array: a transaction copies it (pointers) instead of re-keying every
// row with JSON.stringify — the cost of a write no longer grows with the table.
const tableIndexes = new WeakMap<readonly LocalImRow[], Map<string, LocalImRow>>()
function tableIndex(store: ImStoreName, rows: readonly LocalImRow[]): Map<string, LocalImRow> {
  let index = tableIndexes.get(rows)
  if (!index) tableIndexes.set(rows, index = new Map(rows.map((row) => [JSON.stringify(keyForRow(store, row)), row])))
  return index
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
