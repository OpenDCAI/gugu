import { displayIdentityFromRow } from './displayIdentity'
import { createIndexedDbHandle, type IndexedDbHandle } from './indexedDbHandle'
import { ACCOUNT_REVISION_CURSOR_KEY } from './accountRevisionRuntime'
import { rendererLogger } from './log'

const cacheLog = rendererLogger('im/local-cache')

const DB_NAME = 'gugu.localSync.v1'
// v4(#7290):消息行多了指向字节的列(file_item_id / file_version / file_blob_id)。老客户端存下的行没有这几列,
// 新客户端照它们画会把新式附件当成「文件已删除」(安卓从旧包升上来实测,2026-10-17)。
// ⇒ 升级时丢掉缓存的消息窗口和从它们推出来的东西:`view`(消息窗口视图、账号修订记录)与 `sync_state`(修订游标 ——
//   游标留着,会话列表就当本机已是最新、只拿空的消息仓推可见会话,列表变空,安卓实测)。游标归零 = 冷启动那条路:
//   重新拿一次快照,打开会话时按新的选列取消息。会话、身份、成员、在线、发件箱照留。
const SCHEMA_VERSION = 4
const LEGACY_CHAT_LIST_PREFIX = 'gugu.chatListCache.v2:'

export const IM_STORE_NAMES = [
  'identity',
  'chat',
  'membership',
  'message',
  'stream',
  'presence',
  'outbox',
  'view',
  'sync_state',
] as const

export type ImStoreName = (typeof IM_STORE_NAMES)[number]
export type LocalImRow = { accountId: string; [key: string]: unknown }

export type LocalImDbOperation =
  | { type: 'put'; store: ImStoreName; value: LocalImRow }
  | { type: 'delete'; store: ImStoreName; key: IDBValidKey }
  | { type: 'clearAccount'; accountId: string }

/** Desktop keeps message windows and arrival claims in the local message store (@@@arrival-claim). */
const DESKTOP_DROPPED_VIEW_PREFIXES = ['message-window:', 'message-revision:']
const DESKTOP_DROPPED_VIEWS = new RegExp(`^(${DESKTOP_DROPPED_VIEW_PREFIXES.join('|')})`)

export interface LocalImDbAdapter {
  /** Desktop keeps messages in the session SQLite store; any IndexedDB message rows are legacy and are dropped. */
  prepareLocalMessages?(accountId: string): Promise<void>
  loadAccount(accountId: string): Promise<Record<ImStoreName, LocalImRow[]>>
  commit(operations: readonly LocalImDbOperation[]): Promise<void>
  close(): void
}

const KEY_PATHS: Record<ImStoreName, string[]> = {
  identity: ['accountId', 'id'],
  chat: ['accountId', 'id'],
  membership: ['accountId', 'chatId', 'identityId'],
  message: ['accountId', 'id'],
  stream: ['accountId', 'id'],
  presence: ['accountId', 'identityId'],
  outbox: ['accountId', 'id'],
  view: ['accountId', 'key'],
  sync_state: ['accountId', 'key'],
}

export async function openLocalSyncDb(indexedDb: IDBFactory = window.indexedDB): Promise<LocalImDbAdapter> {
  const handle = createIndexedDbHandle(() => openDatabase(indexedDb))
  await handle.get()
  return createIndexedDbAdapter(handle)
}

export function createMemoryLocalSyncDb(): LocalImDbAdapter {
  let stores = emptyMemoryStores()
  return {
    async prepareLocalMessages(accountId) {
      for (const name of ['message', 'stream', 'view'] as const) {
        for (const [key, row] of stores[name]) if (row.accountId === accountId
          && (name !== 'view' || DESKTOP_DROPPED_VIEWS.test(String(row.key)))) stores[name].delete(key)
      }
    },
    async loadAccount(accountId) {
      assertId(accountId, 'accountId')
      return Object.fromEntries(IM_STORE_NAMES.map((name) => [
        name,
        [...stores[name].values()].filter((row) => row.accountId === accountId).map(cloneRow),
      ])) as Record<ImStoreName, LocalImRow[]>
    },
    async commit(operations) {
      const next = cloneMemoryStores(stores)
      applyMemoryOperations(next, operations)
      stores = next
    },
    close() {},
  }
}

export async function migrateLegacyChatList(
  adapter: LocalImDbAdapter,
  accountId: string,
  storage: Storage = window.localStorage,
): Promise<void> {
  assertId(accountId, 'accountId')
  const key = `${LEGACY_CHAT_LIST_PREFIX}${accountId}`
  const raw = storage.getItem(key)
  if (raw === null) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`legacy chat cache ${key} is not valid JSON`, { cause: error })
  }
  if (!Array.isArray(parsed) || !parsed.every(isLegacyChatRow)) {
    throw new Error(`legacy chat cache ${key} has an invalid row shape`)
  }

  const projected = parsed.slice(0, 300).map((value, order) => ({
    accountId,
    id: value.id,
    order,
    value: stripReadStateVersion(value),
  }))
  const before = (await adapter.loadAccount(accountId)).chat as LegacyChatProjection[]
  await adapter.commit([
    ...before.map((row) => ({ type: 'delete' as const, store: 'chat' as const, key: [accountId, row.id] })),
    ...projected.map((value) => ({ type: 'put' as const, store: 'chat' as const, value })),
  ])
  const migrated = (await adapter.loadAccount(accountId)).chat as LegacyChatProjection[]
  assertChatShadowEqual(projected, migrated, key)
  storage.removeItem(key)
}

type MemoryStores = Record<ImStoreName, Map<string, LocalImRow>>

function emptyMemoryStores(): MemoryStores {
  return Object.fromEntries(IM_STORE_NAMES.map((name) => [name, new Map()])) as MemoryStores
}

function cloneMemoryStores(source: MemoryStores): MemoryStores {
  return Object.fromEntries(IM_STORE_NAMES.map((name) => [name, new Map(source[name])])) as MemoryStores
}

function applyMemoryOperations(stores: MemoryStores, operations: readonly LocalImDbOperation[]): void {
  for (const operation of operations) {
    if (operation.type === 'clearAccount') {
      assertId(operation.accountId, 'accountId')
      for (const store of IM_STORE_NAMES) {
        for (const [key, row] of stores[store]) if (row.accountId === operation.accountId) stores[store].delete(key)
      }
      continue
    }
    if (operation.type === 'put') {
      assertId(operation.value.accountId, 'row.accountId')
      stores[operation.store].set(serializeKey(keyForRow(operation.store, operation.value)), cloneRow(operation.value))
      continue
    }
    stores[operation.store].delete(serializeKey(operation.key))
  }
}

function openDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, SCHEMA_VERSION)
    let migrationError: Error | null = null
    request.onupgradeneeded = (event) => {
      const db = request.result
      const transaction = request.transaction
      if (!transaction) {
        migrationError = new Error('IndexedDB upgrade transaction is missing')
        return
      }
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion
      if (oldVersion === 0) {
        createNormalizedStores(db)
        return
      }
      if (oldVersion === 1 || oldVersion === 2) {
        migrateLegacyVersion(db, transaction, oldVersion, (error) => { migrationError = error })
      }
      if (oldVersion === 3) {
        for (const name of ['message', 'stream', 'view', 'sync_state'] as const) transaction.objectStore(name).clear()
      }
    }
    request.onerror = () => reject(migrationError ?? request.error ?? new Error('Failed to open local IM database'))
    request.onblocked = () => reject(new Error('Local IM database upgrade is blocked by another open client'))
    request.onsuccess = () => resolve(request.result)
  })
}

function createNormalizedStores(db: IDBDatabase): void {
  for (const name of IM_STORE_NAMES) {
    if (db.objectStoreNames.contains(name)) continue
    const store = db.createObjectStore(name, { keyPath: KEY_PATHS[name] })
    store.createIndex('accountId', 'accountId')
    if (name === 'message') {
      store.createIndex('accountChatSeq', ['accountId', 'chatId', 'seq'])
      store.createIndex('accountStreamSeq', ['accountId', 'streamId', 'seq'])
    }
    if (name === 'membership') store.createIndex('accountChat', ['accountId', 'chatId'])
  }
}

const LEGACY_STORES = ['meta', 'messages', 'chatCursor', 'roster', 'profiles', 'outbox'] as const

function migrateLegacyVersion(
  db: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: 1 | 2,
  recordError: (error: Error) => void,
): void {
  const present = LEGACY_STORES.filter((name) => db.objectStoreNames.contains(name))
  const rows = new Map<string, unknown[]>()
  let pending = present.length
  const abort = (error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error))
    recordError(new Error(`Local IM schema v${oldVersion} migration failed: ${normalized.message}`, { cause: normalized }))
    transaction.abort()
  }
  const finish = () => {
    try {
      const normalized = normalizeLegacyRows(rows, oldVersion)
      for (const name of present) db.deleteObjectStore(name)
      createNormalizedStores(db)
      for (const [store, values] of Object.entries(normalized) as [ImStoreName, LocalImRow[]][]) {
        const target = transaction.objectStore(store)
        for (const value of values) target.put(value)
      }
    } catch (error) {
      abort(error)
    }
  }
  if (pending === 0) {
    createNormalizedStores(db)
    return
  }
  for (const name of present) {
    const read = transaction.objectStore(name).getAll()
    read.onerror = () => abort(read.error ?? new Error(`cannot read legacy ${name}`))
    read.onsuccess = () => {
      rows.set(name, read.result)
      pending -= 1
      if (pending === 0) finish()
    }
  }
}

function normalizeLegacyRows(rows: Map<string, unknown[]>, oldVersion: 1 | 2): Record<ImStoreName, LocalImRow[]> {
  const normalized = Object.fromEntries(IM_STORE_NAMES.map((name) => [name, []])) as unknown as Record<ImStoreName, LocalImRow[]>
  const meta = rows.get('meta')?.find((row) => isRecord(row) && row.key === 'session')
  const validMeta = isRecord(meta)
    && meta.schemaVersion === oldVersion
    && typeof meta.userId === 'string'
    && meta.userId.length > 0
  const legacyDataExists = LEGACY_STORES.some((name) => (rows.get(name)?.length ?? 0) > 0)
  if (legacyDataExists && !validMeta) throw new Error('legacy cached rows have no valid meta.session owner')
  const accountId = validMeta ? meta.userId as string : null

  for (const raw of rows.get('profiles') ?? []) {
    if (!accountId || !isRecord(raw)) throw new Error('invalid legacy profile row')
    const id = requiredString(raw.userId, 'profile.userId')
    const type = raw.type
    if (type !== 'human' && type !== 'agent') throw new Error('profile.type must be human or agent')
    const guguNumber = raw.gugu_number === undefined || raw.gugu_number === null
      ? null
      : requiredFiniteNumber(raw.gugu_number, 'profile.gugu_number')
    const value = displayIdentityFromRow({
      id, type, display_name: requiredString(raw.display_name, 'profile.display_name'),
      avatar: optionalString(raw.avatar, 'profile.avatar'), gugu_number: guguNumber,
      bio: null, owner_user_id: null, agent_public: null, desired_status: null,
      device_id: null, category: null, is_official: null, local_path: null,
      created_at: null, updated_at: null,
    })
    normalized.identity.push({ accountId, id, value })
  }
  for (const raw of rows.get('roster') ?? []) {
    if (!accountId || !isRecord(raw)) throw new Error('invalid legacy roster row')
    normalized.membership.push({
      accountId,
      chatId: requiredString(raw.chatId, 'roster.chatId'),
      identityId: requiredString(raw.userId, 'roster.userId'),
      value: raw,
    })
  }
  const streamIds = new Set<string>()
  for (const raw of rows.get('messages') ?? []) {
    if (!accountId || !isRecord(raw) || !isRecord(raw.message)) throw new Error('invalid legacy message row')
    const message = raw.message
    const chatId = requiredString(message.chat_id, 'message.chat_id')
    const id = requiredString(message.id, 'message.id')
    const root = optionalString(message.thread_root_id, 'message.thread_root_id')
    const streamId = root ? `thread:${chatId}:${root}` : `main:${chatId}`
    const seq = requiredFiniteNumber(message.seq, 'message.seq')
    if (requiredString(raw.chatId, 'message envelope chatId') !== chatId
      || requiredFiniteNumber(raw.seq, 'message envelope seq') !== seq) {
      throw new Error(`legacy message envelope mismatch ${id}`)
    }
    validateMessageValue(message, { id, chatId, streamId, seq })
    normalized.message.push({ accountId, id, chatId, streamId, seq, value: message })
    if (!streamIds.has(streamId)) {
      normalized.stream.push({ accountId, id: streamId, chatId, kind: root ? 'thread' : 'main', rootMessageId: root })
      streamIds.add(streamId)
    }
  }
  for (const raw of rows.get('chatCursor') ?? []) {
    if (!accountId || !isRecord(raw)) throw new Error('invalid legacy cursor row')
    const chatId = requiredString(raw.chatId, 'cursor.chatId')
    const oldestSeq = requiredNonNegativeInteger(raw.oldestSeq, 'cursor.oldestSeq')
    const maxSeq = requiredNonNegativeInteger(raw.maxSeq, 'cursor.maxSeq')
    if (oldestSeq > maxSeq || typeof raw.hasMoreOlder !== 'boolean') throw new Error(`invalid legacy cursor bounds ${chatId}`)
    const chatSeqs = normalized.message.filter((row) => row.chatId === chatId).map((row) => row.seq as number)
    if (chatSeqs.length === 0 ? oldestSeq !== 0 || maxSeq !== 0
      : oldestSeq !== Math.min(...chatSeqs) || maxSeq !== Math.max(...chatSeqs)) {
      throw new Error(`legacy cursor does not match message window ${chatId}`)
    }
    normalized.view.push({ accountId, key: `message-window:${chatId}`, value: raw })
  }
  for (const raw of rows.get('outbox') ?? []) {
    if (!isRecord(raw)) throw new Error('invalid legacy outbox row')
    const owner = requiredString(raw.senderUserId, 'outbox.senderUserId')
    const id = requiredString(raw.clientMessageId, 'outbox.clientMessageId')
    requiredString(raw.chatId, 'outbox.chatId')
    if (!isLegacyOutboxPayload(raw.payload)
      || !['pending', 'sending', 'failed'].includes(String(raw.state))
      || !Number.isInteger(raw.attempts)
      || (raw.lastError !== null && typeof raw.lastError !== 'string')
      || typeof raw.enqueuedAt !== 'string'
      || typeof raw.updatedAt !== 'string') {
      throw new Error(`invalid legacy outbox payload ${id}`)
    }
    normalized.outbox.push({ accountId: owner, id, value: raw })
  }
  assertNoConflictingRows(normalized)
  return normalized
}

function assertNoConflictingRows(rows: Record<ImStoreName, LocalImRow[]>): void {
  for (const store of IM_STORE_NAMES) {
    const seen = new Map<string, string>()
    for (const row of rows[store]) {
      const key = serializeKey(keyForRow(store, row))
      const value = JSON.stringify(row)
      const prior = seen.get(key)
      if (prior !== undefined && prior !== value) throw new Error(`conflicting legacy ${store} row ${key}`)
      seen.set(key, value)
    }
  }
}

function createIndexedDbAdapter(handle: IndexedDbHandle): LocalImDbAdapter {
  return {
    async prepareLocalMessages(accountId) {
      assertId(accountId, 'accountId')
      const db = await handle.get()
      const transaction = db.transaction(['message', 'stream', 'view'], 'readwrite')
      const done = transactionDone(transaction)
      // @@@key-range-cleanup - this runs before the account's repository opens, on every desktop start. Key ranges drop the
      // rows in one request per range instead of one cursor step per row; the first start after the upgrade used to walk
      // every message and every view row here (38k steps on an owner-sized account) before the conversation list could show.
      transaction.objectStore('message').delete(IDBKeyRange.bound([accountId], [accountId, []]))
      transaction.objectStore('stream').delete(IDBKeyRange.bound([accountId], [accountId, []]))
      for (const prefix of DESKTOP_DROPPED_VIEW_PREFIXES) {
        transaction.objectStore('view').delete(IDBKeyRange.bound([accountId, prefix], [accountId, `${prefix}\uffff`]))
      }
      await done
    },
    async loadAccount(accountId) {
      assertId(accountId, 'accountId')
      const db = await handle.get()
      const transaction = db.transaction(IM_STORE_NAMES, 'readonly')
      const entries = await Promise.all(IM_STORE_NAMES.map(async (name) => {
        const values = await requestResult<LocalImRow[]>(transaction.objectStore(name).index('accountId').getAll(accountId))
        return [name, values] as const
      }))
      await transactionDone(transaction)
      const raw = Object.fromEntries(entries) as Record<ImStoreName, LocalImRow[]>
      // Validate user-authored data first; never discard an invalid unsent message.
      const outbox = raw.outbox.map((row) => validateCurrentRow('outbox', row, accountId))
      // @@@row-level-cache - server-derived rows are a cache: one row an older build wrote in a shape this build rejects
      // drops that row only. Everything else stays the first frame; dropping the revision cursor makes the account snapshot
      // rebuild the dropped rows behind it. (Discarding the whole cache emptied the list after updates until the snapshot.)
      const dropped: DroppedRow[] = []
      const rows = Object.fromEntries(IM_STORE_NAMES.map((name) => [name, name === 'outbox' ? outbox : raw[name].flatMap((row) => {
        try { return [validateCurrentRow(name, row, accountId)] } catch (error) { dropped.push(droppedRow(name, row, error)); return [] }
      })])) as Record<ImStoreName, LocalImRow[]>
      dropUnrelatedRows(rows, dropped)
      if (dropped.length === 0) return rows
      cacheLog.error({ accountId, count: dropped.length, dropped: dropped.slice(0, 20) }, 'dropped local IM rows this build rejects; rebuilding them from the account snapshot')
      return { ...rows, sync_state: rows.sync_state.filter((row) => row.key !== ACCOUNT_REVISION_CURSOR_KEY) }
    },
    async commit(operations) {
      if (operations.length === 0) return
      const touched = operations.some((operation) => operation.type === 'clearAccount')
        ? [...IM_STORE_NAMES]
        : [...new Set(operations.flatMap((operation) => operation.type === 'clearAccount' ? [] : [operation.store]))]
      const db = await handle.get()
      const transaction = db.transaction(touched, 'readwrite')
      let enqueueError: unknown
      // A clear's cursor must finish BEFORE replacement puts: an advancing
      // IndexedDB cursor would otherwise visit and delete the new rows too.
      const enqueue = (offset: number): void => {
        try {
          for (let index = offset; index < operations.length; index += 1) {
            const operation = operations[index]!
            if (operation.type === 'clearAccount') {
              assertId(operation.accountId, 'accountId')
              let remaining = IM_STORE_NAMES.length
              for (const store of IM_STORE_NAMES) deleteAccountRows(transaction.objectStore(store), operation.accountId, () => {
                remaining -= 1
                if (remaining === 0) enqueue(index + 1)
              })
              return
            } else if (operation.type === 'put') {
              assertId(operation.value.accountId, 'row.accountId')
              transaction.objectStore(operation.store).put(operation.value)
            } else {
              transaction.objectStore(operation.store).delete(operation.key)
            }
          }
        } catch (error) {
          enqueueError = error
          transaction.abort()
        }
      }
      const done = transactionDone(transaction)
      enqueue(0)
      await done.catch((error) => { throw enqueueError ?? error })
    },
    close: () => handle.close(),
  }
}

function deleteAccountRows(store: IDBObjectStore, accountId: string, done: () => void): void {
  const cursor = store.index('accountId').openKeyCursor(IDBKeyRange.only(accountId))
  cursor.onsuccess = () => {
    const current = cursor.result
    if (!current) { done(); return }
    store.delete(current.primaryKey)
    current.continue()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    request.onsuccess = () => resolve(request.result)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function keyForRow(store: ImStoreName, row: LocalImRow): IDBValidKey {
  return KEY_PATHS[store].map((part) => {
    const value = (row as Record<string, unknown>)[part]
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${store}.${part} must be a non-empty string`)
    return value
  })
}

function serializeKey(key: IDBValidKey): string {
  return JSON.stringify(key)
}

function cloneRow<T extends LocalImRow>(row: T): T {
  return structuredClone(row)
}

type LegacyChatProjection = { accountId: string; id: string; order: number; value: Record<string, unknown> }

function isLegacyChatRow(value: unknown): value is Record<string, unknown> & { id: string } {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.kind === 'string'
    && typeof value.name === 'string'
    && typeof value.created_at === 'string'
}

function stripReadStateVersion(value: Record<string, unknown>): Record<string, unknown> {
  const { read_state_version: _discarded, ...projection } = value
  return projection
}

function assertChatShadowEqual(expected: LegacyChatProjection[], actual: LegacyChatProjection[], key: string): void {
  const canonical = (rows: LegacyChatProjection[]) => rows
    .map((row) => ({ id: row.id, order: row.order, value: stripReadStateVersion(row.value) }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  if (JSON.stringify(canonical(expected)) !== JSON.stringify(canonical(actual))) {
    throw new Error(`legacy chat cache shadow mismatch under ${key}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return requiredString(value, label)
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const number = requiredFiniteNumber(value, label)
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer`)
  return number
}

function validateCurrentRow(store: ImStoreName, raw: unknown, accountId: string): LocalImRow {
  if (!isRecord(raw) || raw.accountId !== accountId) throw new Error(`invalid current ${store} row`)
  try {
    keyForRow(store, raw as LocalImRow)
    if (store === 'identity') {
      const identity = displayIdentityFromRow(raw.value)
      if (identity.id !== raw.id) throw new Error('identity relation')
      return { ...raw, value: identity } as unknown as LocalImRow
    } else if (store === 'presence') {
      if (!isRecord(raw.value)) throw new Error('value')
    } else if (store === 'chat') {
      const value = raw.value
      if (!isRecord(value) || value.id !== raw.id
        || typeof value.kind !== 'string' || typeof value.name !== 'string' || typeof value.created_at !== 'string') throw new Error('chat')
      // 10-28 之前的客户端落的行没有 addressed_count:按无效缓存走快照重建,❌ 拿全部未读顶上。
      if (value.unread_locator != null && (!isRecord(value.unread_locator) || !Number.isInteger(value.unread_locator.addressed_count))) throw new Error('chat unread_locator')
    } else if (store === 'membership') {
      if (!isRecord(raw.value) || typeof raw.value.role !== 'string') throw new Error('membership')
    } else if (store === 'message') {
      const value = raw.value
      validateMessageValue(value, raw)
    } else if (store === 'stream') {
      if (typeof raw.chatId !== 'string' || !['main', 'thread'].includes(String(raw.kind))
        || (raw.rootMessageId !== null && typeof raw.rootMessageId !== 'string')) throw new Error('stream')
      const expected = raw.kind === 'main'
        ? `main:${raw.chatId}`
        : `thread:${raw.chatId}:${requiredString(raw.rootMessageId, 'stream.rootMessageId')}`
      if (raw.id !== expected || (raw.kind === 'main' && raw.rootMessageId !== null)) throw new Error('stream relation')
    } else if (store === 'outbox') {
      if (!isRecord(raw.value) || raw.value.clientMessageId !== raw.id || raw.value.senderUserId !== accountId
        || typeof raw.value.chatId !== 'string' || !isLegacyOutboxPayload(raw.value.payload)
        || !['pending', 'sending', 'uploading', 'failed'].includes(String(raw.value.state)) || !Number.isInteger(raw.value.attempts)
        || (raw.value.lastError !== null && typeof raw.value.lastError !== 'string')
        || typeof raw.value.enqueuedAt !== 'string' || typeof raw.value.updatedAt !== 'string') throw new Error('outbox')
    }
  } catch (error) {
    throw new Error(`invalid current ${store} row`, { cause: error })
  }
  return raw as LocalImRow
}

function validateMessageValue(value: unknown, row: Record<string, unknown>): void {
  if (!isRecord(value)
    || value.id !== row.id || value.chat_id !== row.chatId || value.seq !== row.seq
    || !Number.isInteger(row.seq) || (row.seq as number) < 0
    || (value.sender_user_id !== null && typeof value.sender_user_id !== 'string')
    || (value.to_user_ids !== null && (!Array.isArray(value.to_user_ids) || value.to_user_ids.some((id) => typeof id !== 'string')))
    || (value.content !== null && typeof value.content !== 'string')
    || !['text', 'card', 'system', 'attachment', 'widget'].includes(String(value.content_type))
    || (value.reply_to_message_id !== null && typeof value.reply_to_message_id !== 'string')
    || (value.retracted_at !== null && typeof value.retracted_at !== 'string')
    || typeof value.created_at !== 'string'
    || !Array.isArray(value.reactions) || !value.reactions.every(isReaction)
    || typeof value.is_mine !== 'boolean' || typeof value.delivered !== 'boolean'
    || (value.delivery_status !== null && !['delivered', 'read'].includes(String(value.delivery_status)))) throw new Error('message shape')
  const root = optionalString(value.thread_root_id, 'message.thread_root_id')
  const expectedStream = root ? `thread:${row.chatId}:${root}` : `main:${row.chatId}`
  if (row.streamId !== expectedStream) throw new Error('message stream relation')
}

function isReaction(value: unknown): boolean {
  return isRecord(value) && typeof value.emoji === 'string' && Number.isInteger(value.count)
    && (value.count as number) >= 0 && typeof value.my_reaction === 'boolean'
}

type DroppedRow = { store: ImStoreName; key: string; reason: string }

function droppedRow(store: ImStoreName, row: unknown, error: unknown): DroppedRow {
  const key = isRecord(row) ? String(row.id ?? row.key ?? row.identityId ?? '?') : '?'
  const reasons: string[] = []
  for (let cause = error; cause instanceof Error; cause = cause.cause) reasons.push(cause.message)
  return { store, key, reason: reasons.join(' <- ') }
}

/** Rows whose partner was dropped (or never written) are dropped too: a message needs its stream, a window must cover its messages. */
function dropUnrelatedRows(rows: Record<ImStoreName, LocalImRow[]>, dropped: DroppedRow[]): void {
  const streamIds = new Set(rows.stream.map((row) => row.id as string))
  rows.message = rows.message.filter((message) => streamIds.has(message.streamId as string)
    || (dropped.push({ store: 'message', key: String(message.id), reason: `stream ${String(message.streamId)} is missing` }), false))
  const seqRange = new Map<string, { oldest: number; max: number }>()
  for (const message of rows.message) {
    const seq = message.seq as number
    const range = seqRange.get(message.streamId as string)
    if (!range) seqRange.set(message.streamId as string, { oldest: seq, max: seq })
    else { range.oldest = Math.min(range.oldest, seq); range.max = Math.max(range.max, seq) }
  }
  rows.view = rows.view.filter((view) => {
    const key = view.key as string
    if (!key.startsWith('message-window:')) return true
    const chatId = key.slice('message-window:'.length)
    const value = view.value
    const range = seqRange.get(`main:${chatId}`) ?? { oldest: 0, max: 0 }
    const valid = !!chatId && isRecord(value) && typeof value.hasMoreOlder === 'boolean'
      && value.oldestSeq === range.oldest && value.maxSeq === range.max
    if (!valid) dropped.push({ store: 'view', key, reason: `message window does not cover stored messages ${range.oldest}..${range.max}` })
    return valid
  })
}

function isLegacyOutboxPayload(value: unknown): boolean {
  return isRecord(value)
    && typeof value.content === 'string'
    && typeof value.contentType === 'string'
    && (value.toUserIds === null || (Array.isArray(value.toUserIds) && value.toUserIds.every((id) => typeof id === 'string' && id.length > 0)))
    && (value.replyToMessageId === null || typeof value.replyToMessageId === 'string')
    && (value.threadRootId === null || typeof value.threadRootId === 'string')
    && typeof value.isThreadRoot === 'boolean'
    && typeof value.isWhisper === 'boolean'
}

function assertId(value: string, label: string): void {
  if (!value) throw new Error(`${label} must be a non-empty string`)
}
