import { expect, test, type Page } from '@playwright/test'

const DB_NAME = 'gugu.localSync.v1'

function messageValue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'message-1',
    chat_id: 'chat-1',
    sender_user_id: 'account-a',
    to_user_ids: null,
    sender_name: 'Account A',
    sender_avatar: null,
    seq: 1,
    content: 'hello',
    content_type: 'text',
    reply_to_message_id: null,
    retracted_at: null,
    created_at: '2026-08-09T00:00:00.000Z',
    reactions: [],
    is_mine: true,
    delivered: true,
    delivery_status: null,
    thread_root_id: null,
    ...overrides,
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async (name) => {
    localStorage.clear()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`delete blocked: ${name}`))
    })
  }, DB_NAME)
})

test('real repository API commits, selects, subscribes, recovers outbox, and isolates account reset', async ({ page }) => {
  const result = await page.evaluate(async (message) => {
    const moduleUrl = '/src/lib/imRepository.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    const outbox = {
      clientMessageId: 'message-1',
      chatId: 'chat-1',
      senderUserId: 'account-a',
      payload: {
        content: 'hello',
        contentType: 'text',
        toUserIds: null,
        replyToMessageId: null,
        threadRootId: null,
        isThreadRoot: false,
        isWhisper: false,
      },
      state: 'pending',
      attempts: 0,
      lastError: null,
      enqueuedAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    }
    const repositoryA = await repositoryModule.openImRepository('account-a')
    const notifications: number[] = []
    repositoryA.subscribe(repositoryModule.imSelectors.chats, (chats: unknown[]) => notifications.push(chats.length))
    await repositoryA.transaction((transaction: Record<string, (...args: unknown[]) => void>) => {
      transaction.putIdentity({
        id: 'identity-1', type: 'human', display_name: 'One', avatar: null,
        gugu_number: null, bio: null, owner_user_id: null, agent_public: null,
        desired_status: null, device_id: null, category: null, is_official: null,
        local_path: null, created_at: null, updated_at: '2026-08-09T00:00:00.000Z',
      })
      transaction.putChat('chat-1', { id: 'chat-1', kind: 'group', name: 'A', created_at: '2026-08-09T00:00:00.000Z' })
      transaction.putMembership('chat-1', 'identity-1', { role: 'member' })
      transaction.putMessage(message)
      transaction.putStream('thread:chat-1:root-1', 'chat-1', 'thread', 'root-1')
      transaction.putPresence('identity-1', { state: 'online' })
      transaction.putOutbox(outbox)
      transaction.putView('active-chat', 'chat-1')
      transaction.putSyncState('cursor', { revision: 1 })
    })
    const committedCounts = Object.fromEntries(
      Object.entries(repositoryA.snapshot()).map(([store, rows]) => [store, (rows as unknown[]).length]),
    )
    repositoryA.close()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const recoveredA = await repositoryModule.openImRepository('account-a')
    const recoveredOutbox = repositoryModule.readOutboxRecords(recoveredA).map((row: { clientMessageId: string }) => row.clientMessageId)
    await repositoryModule.ackOutboxRecord(recoveredA, 'message-1', message)
    const afterAck = {
      outbox: repositoryModule.readOutboxRecords(recoveredA).length,
      messages: repositoryModule.imSelectors.messagesForChat('chat-1')(recoveredA.snapshot()).length,
    }
    const resetNotifications: number[] = []
    recoveredA.subscribe(repositoryModule.imSelectors.chats, (chats: unknown[]) => resetNotifications.push(chats.length))

    const repositoryB = await repositoryModule.openImRepository('account-b')
    await repositoryB.transaction((transaction: Record<string, (...args: unknown[]) => void>) => {
      transaction.putChat('chat-1', { id: 'chat-1', kind: 'group', name: 'B', created_at: '2026-08-09T00:00:00.000Z' })
    })
    await recoveredA.reset()
    const isolated = {
      accountAChats: repositoryModule.readChatRows(recoveredA).length,
      accountBChatName: repositoryModule.readChatRows(repositoryB)[0]?.name,
    }
    recoveredA.close()
    repositoryB.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { notifications, committedCounts, recoveredOutbox, afterAck, resetNotifications, isolated }
  }, messageValue())

  expect(result.notifications).toEqual([0, 1])
  expect(result.committedCounts).toMatchObject({
    identity: 1, chat: 1, membership: 1, message: 1, stream: 2,
    presence: 1, outbox: 1, view: 1, sync_state: 1,
  })
  expect(result.recoveredOutbox).toEqual(['message-1'])
  expect(result.afterAck).toEqual({ outbox: 0, messages: 1 })
  expect(result.resetNotifications).toEqual([1, 0])
  expect(result.isolated).toEqual({ accountAChats: 0, accountBChatName: 'B' })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async (name) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`delete blocked: ${name}`))
    })
  }, DB_NAME)
})

test('v2 upgrade atomically normalizes account rows and removes every legacy store', async ({ page }) => {
  await seedVersionTwo(page, 'valid')

  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/localSyncDb.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    const adapter = await repositoryModule.openLocalSyncDb()
    const accountA = await adapter.loadAccount('account-a')
    const accountB = await adapter.loadAccount('account-b')
    adapter.close()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gugu.localSync.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = Array.from(database.objectStoreNames)
    const version = database.version
    const transaction = database.transaction(stores, 'readonly')
    const schema = Object.fromEntries(stores.map((name) => {
      const store = transaction.objectStore(name)
      return [name, {
        keyPath: Array.isArray(store.keyPath) ? Array.from(store.keyPath) : store.keyPath,
        indexes: Array.from(store.indexNames).sort(),
      }]
    }))
    database.close()
    return {
      version,
      stores, schema,
      accountA: Object.fromEntries(Object.entries(accountA).map(([store, rows]) => [store, (rows as unknown[]).length])),
      accountB: Object.fromEntries(Object.entries(accountB).map(([store, rows]) => [store, (rows as unknown[]).length])),
    }
  })

  expect(result.version).toBe(4)
  expect(result.stores.sort()).toEqual([
    'chat', 'identity', 'membership', 'message', 'outbox', 'presence', 'stream', 'sync_state', 'view',
  ])
  expect(result.accountA).toMatchObject({ identity: 2, membership: 2, message: 2, stream: 1, view: 1, outbox: 1 })
  expect(result.accountB).toMatchObject({ outbox: 1 })
  expect(result.schema).toEqual({
    chat: { keyPath: ['accountId', 'id'], indexes: ['accountId'] },
    identity: { keyPath: ['accountId', 'id'], indexes: ['accountId'] },
    membership: { keyPath: ['accountId', 'chatId', 'identityId'], indexes: ['accountChat', 'accountId'] },
    message: { keyPath: ['accountId', 'id'], indexes: ['accountChatSeq', 'accountId', 'accountStreamSeq'] },
    outbox: { keyPath: ['accountId', 'id'], indexes: ['accountId'] },
    presence: { keyPath: ['accountId', 'identityId'], indexes: ['accountId'] },
    stream: { keyPath: ['accountId', 'id'], indexes: ['accountId'] },
    sync_state: { keyPath: ['accountId', 'key'], indexes: ['accountId'] },
    view: { keyPath: ['accountId', 'key'], indexes: ['accountId'] },
  })
})

test('published v1 upgrades every legacy row directly to v4', async ({ page }) => {
  await seedVersionOne(page)

  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/localSyncDb.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    let error = ''
    let counts: Record<string, number> = {}
    try {
      const adapter = await repositoryModule.openLocalSyncDb()
      const rows = await adapter.loadAccount('account-a')
      counts = Object.fromEntries(Object.entries(rows).map(([store, values]) => [store, (values as unknown[]).length]))
      adapter.close()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gugu.localSync.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const version = database.version
    const stores = Array.from(database.objectStoreNames)
    database.close()
    return { error, counts, version, stores }
  })

  expect(result.error).toBe('')
  expect(result.version).toBe(4)
  expect(result.stores.sort()).toEqual([
    'chat', 'identity', 'membership', 'message', 'outbox', 'presence', 'stream', 'sync_state', 'view',
  ])
  expect(result.counts).toMatchObject({ identity: 2, membership: 2, message: 2, stream: 1, view: 1 })
})

// #7290 v3 → v4:老客户端存下的消息行没有指向字节的列 ⇒ 消息窗口和从它推出来的(stream、view、sync_state 游标)丢掉重取;
// 会话、身份、成员、在线、发件箱照留。
test('v3 upgrades to v4 by dropping the cached message window and its cursors, keeping the rest', async ({ page }) => {
  await page.evaluate(async (name) => {
    const keyPaths: Record<string, string[]> = {
      identity: ['accountId', 'id'], chat: ['accountId', 'id'], membership: ['accountId', 'chatId', 'identityId'],
      message: ['accountId', 'id'], stream: ['accountId', 'id'], presence: ['accountId', 'identityId'],
      outbox: ['accountId', 'id'], view: ['accountId', 'key'], sync_state: ['accountId', 'key'],
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 3)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        for (const [storeName, keyPath] of Object.entries(keyPaths)) {
          const store = request.result.createObjectStore(storeName, { keyPath })
          store.createIndex('accountId', 'accountId')
          if (storeName === 'message') {
            store.createIndex('accountChatSeq', ['accountId', 'chatId', 'seq'])
            store.createIndex('accountStreamSeq', ['accountId', 'streamId', 'seq'])
          }
          if (storeName === 'membership') store.createIndex('accountChat', ['accountId', 'chatId'])
        }
      }
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(Object.keys(keyPaths), 'readwrite')
        for (const [storeName, keyPath] of Object.entries(keyPaths)) {
          transaction.objectStore(storeName).put(Object.fromEntries(keyPath.map((key) => [key, key === 'accountId' ? 'account-a' : `${storeName}-1`])))
        }
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  }, DB_NAME)

  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/localSyncDb.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    const adapter = await repositoryModule.openLocalSyncDb()
    adapter.close()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gugu.localSync.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = Array.from(database.objectStoreNames)
    const transaction = database.transaction(stores, 'readonly')
    const counts = Object.fromEntries(await Promise.all(stores.map((store) => new Promise<[string, number]>((resolve, reject) => {
      const request = transaction.objectStore(store).count()
      request.onsuccess = () => resolve([store, request.result])
      request.onerror = () => reject(request.error)
    }))))
    const version = database.version
    database.close()
    return { version, counts }
  })

  expect(result.version).toBe(4)
  expect(result.counts).toEqual({ chat: 1, identity: 1, membership: 1, presence: 1, outbox: 1, message: 0, stream: 0, view: 0, sync_state: 0 })
})

for (const version of [1, 2] as const) {
  test(`published v${version} empty 0/0 window upgrades to v4`, async ({ page }) => {
    await seedEmptyLegacy(page, version, 0)
    const result = await openLegacyUpgrade(page)
    expect(result).toMatchObject({ error: '', version: 4, view: { oldestSeq: 0, maxSeq: 0, hasMoreOlder: true } })
  })

  test(`published v${version} empty nonzero window rolls back byte-for-byte`, async ({ page }) => {
    await seedEmptyLegacy(page, version, 99)
    const before = await dumpLegacyDatabase(page)
    const result = await openLegacyUpgrade(page)
    expect(result.error).toContain(`Local IM schema v${version} migration failed`)
    expect(result.version).toBe(version)
    expect(await dumpLegacyDatabase(page)).toEqual(before)
  })
}

test('atomic outbox ack keeps the main cached window reopenable and excludes thread ack', async ({ page }) => {
  const result = await page.evaluate(async ({ mainOne, mainTwo, thread }) => {
    const moduleUrl = '/src/lib/imRepository.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    const outboxFor = (message: Record<string, unknown>) => ({
      clientMessageId: message.id, chatId: 'chat-1', senderUserId: 'account-a',
      payload: { content: message.content, contentType: 'text', toUserIds: null, replyToMessageId: null,
        threadRootId: message.thread_root_id, isThreadRoot: false, isWhisper: false },
      state: 'pending', attempts: 0, lastError: null,
      enqueuedAt: '2026-08-09T00:00:00.000Z', updatedAt: '2026-08-09T00:00:00.000Z',
    })
    const repository = await repositoryModule.openImRepository('account-a')
    await repositoryModule.replaceMessageWindow(repository, 'chat-1', [mainOne], true)
    await repositoryModule.putOutboxRecord(repository, outboxFor(mainTwo))
    await repositoryModule.ackOutboxRecord(repository, mainTwo.id, mainTwo)
    repository.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let error = ''
    let afterMain: Record<string, unknown> = {}
    let afterThread: Record<string, unknown> = {}
    try {
      const reopened = await repositoryModule.openImRepository('account-a')
      const window = repositoryModule.readMessageWindow(reopened, 'chat-1')
      afterMain = { ids: window?.messages.map((row: { id: string }) => row.id), maxSeq: window?.maxSeq,
        outbox: repositoryModule.readOutboxRecords(reopened).length }
      await repositoryModule.putOutboxRecord(reopened, outboxFor(thread))
      await repositoryModule.ackOutboxRecord(reopened, thread.id, thread)
      reopened.close()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const final = await repositoryModule.openImRepository('account-a')
      const finalWindow = repositoryModule.readMessageWindow(final, 'chat-1')
      afterThread = { ids: finalWindow?.messages.map((row: { id: string }) => row.id), maxSeq: finalWindow?.maxSeq,
        outbox: repositoryModule.readOutboxRecords(final).length }
      final.close()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    return { error, afterMain, afterThread }
  }, {
    mainOne: messageValue({ id: 'main-1', seq: 1 }),
    mainTwo: messageValue({ id: 'main-2', seq: 2 }),
    thread: messageValue({ id: 'thread-3', seq: 3, thread_root_id: 'root-1' }),
  })

  expect(result).toEqual({
    error: '',
    afterMain: { ids: ['main-1', 'main-2'], maxSeq: 2, outbox: 0 },
    afterThread: { ids: ['main-1', 'main-2'], maxSeq: 2, outbox: 0 },
  })
})

test('a malformed v1 row rolls back version and preserves every legacy byte', async ({ page }) => {
  await seedVersionOne(page, 'envelope-mismatch')
  const before = await dumpLegacyDatabase(page)
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/localSyncDb.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    let error = ''
    try { await repositoryModule.openLocalSyncDb() } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gugu.localSync.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const version = database.version
    const stores = Array.from(database.objectStoreNames)
    database.close()
    return { error, version, stores }
  })
  expect(result.error).toContain('Local IM schema v1 migration failed')
  expect(result.version).toBe(1)
  expect(result.stores.sort()).toEqual(['chatCursor', 'messages', 'meta', 'profiles', 'roster'])
  expect(await dumpLegacyDatabase(page)).toEqual(before)
})

test('a synchronous DataCloneError aborts earlier requests in the same real IDB transaction', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/lib/imRepository.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    const repository = await repositoryModule.openImRepository('account-a')
    const notifications: number[] = []
    repository.subscribe(repositoryModule.imSelectors.chats, (rows: unknown[]) => notifications.push(rows.length))
    let error = ''
    try {
      await repository.transaction((transaction: Record<string, (...args: unknown[]) => void>) => {
        transaction.putChat('first-valid', {
          id: 'first-valid', kind: 'group', status: 'active', name: 'First', created_at: '2026-08-09T00:00:00.000Z',
        })
        transaction.putView('second-uncloneable', { callback: () => undefined })
      })
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}:${caught.message}` : String(caught)
    }
    repository.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const reopened = await repositoryModule.openImRepository('account-a')
    const counts = Object.fromEntries(
      Object.entries(reopened.snapshot()).map(([store, rows]) => [store, (rows as unknown[]).length]),
    )
    reopened.close()
    return { error, notifications, counts }
  })

  expect(result.error).toContain('DataCloneError')
  expect(result.notifications).toEqual([0])
  expect(Object.values(result.counts)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
})

for (const store of ['identity', 'chat', 'membership', 'message', 'stream', 'presence', 'outbox', 'view', 'sync_state'] as const) {
  test(`malformed current v4 ${store} row fails at repository open`, async ({ page }) => {
    await seedMalformedCurrentVersion(page, store)
    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/lib/imRepository.ts'
      const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
      let error = ''
      let loaded = -1
      try {
        const repository = await repositoryModule.openImRepository('account-a')
        loaded = Object.values(repository.snapshot()).reduce((sum: number, rows) => sum + (rows as unknown[]).length, 0)
        repository.close()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      return { error, loaded }
    })

    expect(result.error).toContain(`invalid current ${store} row`)
    expect(result.loaded).toBe(-1)
  })
}

for (const relation of ['missing-message-field', 'message-stream-id', 'missing-message-stream', 'stream-shape', 'message-window-bounds'] as const) {
  test(`relationally malformed current v4 ${relation} fails at repository open`, async ({ page }) => {
    await seedRelationallyMalformedCurrentVersion(page, relation)
    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/lib/imRepository.ts'
      const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
      let error = ''
      let loaded = -1
      try {
        const repository = await repositoryModule.openImRepository('account-a')
        loaded = Object.values(repository.snapshot()).reduce((sum: number, rows) => sum + (rows as unknown[]).length, 0)
        repository.close()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      return { error, loaded }
    })

    expect(result.error).toContain('invalid current')
    expect(result.loaded).toBe(-1)
  })
}

for (const invalid of ['missing-meta', 'invalid-meta', 'malformed-outbox', 'envelope-mismatch', 'cursor-mismatch', 'duplicate-id'] as const) {
  test(`${invalid} aborts the whole upgrade and leaves the complete v2 schema`, async ({ page }) => {
    await seedVersionTwo(page, invalid)
    const before = await dumpLegacyDatabase(page)

    const result = await page.evaluate(async () => {
      const moduleUrl = '/src/lib/localSyncDb.ts'
      const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
      let error = ''
      try {
        await repositoryModule.openLocalSyncDb()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('gugu.localSync.v1')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const stores = Array.from(database.objectStoreNames)
      const version = database.version
      database.close()
      return { error, stores, version }
    })

    expect(result.error).toContain('Local IM schema v2 migration failed')
    expect(result.version).toBe(2)
    expect(result.stores.sort()).toEqual(['chatCursor', 'messages', 'meta', 'outbox', 'profiles', 'roster'])
    expect(await dumpLegacyDatabase(page)).toEqual(before)
  })
}

type VersionTwoShape = 'valid' | 'missing-meta' | 'invalid-meta' | 'malformed-outbox' | 'envelope-mismatch' | 'cursor-mismatch' | 'duplicate-id'

async function seedVersionTwo(page: Page, shape: VersionTwoShape): Promise<void> {
  const firstMessage = messageValue()
  const secondMessage = messageValue({ id: 'message-2', seq: 2, content: 'second' })
  await page.evaluate(async ({ name, shape, firstMessage, secondMessage }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 2)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('meta', { keyPath: 'key' })
        const messages = database.createObjectStore('messages', { keyPath: ['chatId', 'seq'] })
        messages.createIndex('chatId', 'chatId')
        database.createObjectStore('chatCursor', { keyPath: 'chatId' })
        const roster = database.createObjectStore('roster', { keyPath: ['chatId', 'userId'] })
        roster.createIndex('chatId', 'chatId')
        database.createObjectStore('profiles', { keyPath: 'userId' })
        const outbox = database.createObjectStore('outbox', { keyPath: 'clientMessageId' })
        outbox.createIndex('chatId', 'chatId')
      }
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(
          ['meta', 'messages', 'chatCursor', 'roster', 'profiles', 'outbox'],
          'readwrite',
        )
        if (shape !== 'missing-meta') {
          transaction.objectStore('meta').put({
            key: 'session',
            schemaVersion: shape === 'invalid-meta' ? 1 : 2,
            userId: 'account-a',
          })
        }
        transaction.objectStore('messages').put({
          chatId: shape === 'envelope-mismatch' ? 'wrong-chat' : 'chat-1',
          seq: 1,
          message: firstMessage,
        })
        if (shape === 'duplicate-id') transaction.objectStore('messages').put({
          chatId: 'chat-2', seq: 2,
          message: { ...secondMessage, id: 'message-1', chat_id: 'chat-2' },
        })
        transaction.objectStore('chatCursor').put({
          chatId: 'chat-1', maxSeq: shape === 'cursor-mismatch' ? 99 : shape === 'valid' ? 2 : 1,
          oldestSeq: 1, hasMoreOlder: false,
        })
        transaction.objectStore('profiles').put({ userId: 'identity-1', display_name: 'One', type: 'human' })
        transaction.objectStore('roster').put({ chatId: 'chat-1', userId: 'identity-1', role: 'member', type: 'human' })
        if (shape === 'valid') {
          transaction.objectStore('messages').put({
            chatId: 'chat-1', seq: 2,
            message: secondMessage,
          })
          transaction.objectStore('profiles').put({ userId: 'identity-2', display_name: 'Two', type: 'human' })
          transaction.objectStore('roster').put({ chatId: 'chat-1', userId: 'identity-2', role: 'member', type: 'human' })
        }
        const validOutbox = (id: string, senderUserId: string) => ({
          clientMessageId: id,
          chatId: 'chat-1',
          senderUserId,
          payload: {
            content: id,
            contentType: 'text',
            toUserIds: null,
            replyToMessageId: null,
            threadRootId: null,
            isThreadRoot: false,
            isWhisper: false,
          },
          state: 'pending',
          attempts: 0,
          lastError: null,
          enqueuedAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
        })
        transaction.objectStore('outbox').put(
          shape === 'malformed-outbox'
            ? { ...validOutbox('outbox-a', 'account-a'), payload: { content: 42 } }
            : validOutbox('outbox-a', 'account-a'),
        )
        if (shape === 'valid') transaction.objectStore('outbox').put(validOutbox('outbox-b', 'account-b'))
        transaction.oncomplete = () => {
          database.close()
          resolve()
        }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  }, { name: DB_NAME, shape, firstMessage, secondMessage })
}

async function seedVersionOne(page: Page, shape: 'valid' | 'envelope-mismatch' = 'valid'): Promise<void> {
  const firstMessage = messageValue()
  const secondMessage = messageValue({ id: 'message-2', seq: 2, content: 'second' })
  await page.evaluate(async ({ name, shape, firstMessage, secondMessage }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('meta', { keyPath: 'key' })
        const messages = database.createObjectStore('messages', { keyPath: ['chatId', 'seq'] })
        messages.createIndex('chatId', 'chatId')
        database.createObjectStore('chatCursor', { keyPath: 'chatId' })
        const roster = database.createObjectStore('roster', { keyPath: ['chatId', 'userId'] })
        roster.createIndex('chatId', 'chatId')
        database.createObjectStore('profiles', { keyPath: 'userId' })
      }
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(['meta', 'messages', 'chatCursor', 'roster', 'profiles'], 'readwrite')
        transaction.objectStore('meta').put({ key: 'session', schemaVersion: 1, userId: 'account-a' })
        transaction.objectStore('messages').put({
          chatId: shape === 'envelope-mismatch' ? 'wrong-chat' : 'chat-1', seq: 1,
          message: firstMessage,
        })
        transaction.objectStore('messages').put({
          chatId: 'chat-1', seq: 2,
          message: secondMessage,
        })
        transaction.objectStore('chatCursor').put({ chatId: 'chat-1', maxSeq: 2, oldestSeq: 1, hasMoreOlder: false })
        transaction.objectStore('profiles').put({ userId: 'identity-1', display_name: 'One', type: 'human' })
        transaction.objectStore('roster').put({ chatId: 'chat-1', userId: 'identity-1', role: 'member', type: 'human' })
        transaction.objectStore('profiles').put({ userId: 'identity-2', display_name: 'Two', type: 'human' })
        transaction.objectStore('roster').put({ chatId: 'chat-1', userId: 'identity-2', role: 'member', type: 'human' })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  }, { name: DB_NAME, shape, firstMessage, secondMessage })
}

async function seedEmptyLegacy(page: Page, version: 1 | 2, maxSeq: number): Promise<void> {
  await page.evaluate(async ({ name, version, maxSeq }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, version)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('meta', { keyPath: 'key' })
        database.createObjectStore('messages', { keyPath: ['chatId', 'seq'] })
        database.createObjectStore('chatCursor', { keyPath: 'chatId' })
        database.createObjectStore('profiles', { keyPath: 'userId' })
        database.createObjectStore('roster', { keyPath: ['chatId', 'userId'] })
        if (version === 2) database.createObjectStore('outbox', { keyPath: 'clientMessageId' })
      }
      request.onsuccess = () => {
        const database = request.result
        const stores = Array.from(database.objectStoreNames)
        const transaction = database.transaction(stores, 'readwrite')
        transaction.objectStore('meta').put({ key: 'session', schemaVersion: version, userId: 'account-a' })
        transaction.objectStore('chatCursor').put({ chatId: 'chat-1', oldestSeq: 0, maxSeq, hasMoreOlder: true })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  }, { name: DB_NAME, version, maxSeq })
}

async function openLegacyUpgrade(page: Page): Promise<{ error: string; version: number; view?: unknown }> {
  return page.evaluate(async () => {
    const moduleUrl = '/src/lib/localSyncDb.ts'
    const repositoryModule = await import(/* @vite-ignore */ moduleUrl)
    let error = ''
    let view: unknown
    try {
      const adapter = await repositoryModule.openLocalSyncDb()
      view = (await adapter.loadAccount('account-a')).view[0]?.value
      adapter.close()
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught)
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gugu.localSync.v1')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const version = database.version
    database.close()
    return { error, version, view }
  })
}

async function dumpLegacyDatabase(page: Page): Promise<Record<string, unknown[]>> {
  return page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const stores = Array.from(database.objectStoreNames)
    const transaction = database.transaction(stores, 'readonly')
    const entries = await Promise.all(stores.map((store) => new Promise<[string, unknown[]]>((resolve, reject) => {
      const request = transaction.objectStore(store).getAll()
      request.onsuccess = () => resolve([store, request.result])
      request.onerror = () => reject(request.error)
    })))
    database.close()
    return Object.fromEntries(entries)
  }, DB_NAME)
}

async function seedMalformedCurrentVersion(
  page: Page,
  malformedStore: 'identity' | 'chat' | 'membership' | 'message' | 'stream' | 'presence' | 'outbox' | 'view' | 'sync_state',
): Promise<void> {
  await page.evaluate(async ({ name, malformedStore, malformedMessage }) => {
    const keyPaths: Record<string, string[]> = {
      identity: ['accountId', 'id'], chat: ['accountId', 'id'], membership: ['accountId', 'chatId', 'identityId'],
      message: ['accountId', 'id'], stream: ['accountId', 'id'], presence: ['accountId', 'identityId'],
      outbox: ['accountId', 'id'], view: ['accountId', 'key'], sync_state: ['accountId', 'key'],
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 4)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        for (const [storeName, keyPath] of Object.entries(keyPaths)) {
          const store = request.result.createObjectStore(storeName, { keyPath })
          store.createIndex('accountId', 'accountId')
          if (storeName === 'message') {
            store.createIndex('accountChatSeq', ['accountId', 'chatId', 'seq'])
            store.createIndex('accountStreamSeq', ['accountId', 'streamId', 'seq'])
          }
          if (storeName === 'membership') store.createIndex('accountChat', ['accountId', 'chatId'])
        }
      }
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction(malformedStore, 'readwrite')
        const rows = {
          identity: { accountId: 'account-a', id: 'identity-1', value: null },
          chat: { accountId: 'account-a', id: 'chat-1', order: 'first', value: { id: 42 } },
          membership: { accountId: 'account-a', chatId: 'chat-1', identityId: 'identity-1', value: { role: 42 } },
          message: { accountId: 'account-a', id: 'message-1', chatId: 'chat-1', streamId: 'main:chat-1', seq: -1, value: malformedMessage },
          stream: { accountId: 'account-a', id: 'main:chat-1', chatId: 42, kind: 'other', rootMessageId: null },
          presence: { accountId: 'account-a', identityId: 'identity-1', value: null },
          outbox: { accountId: 'account-a', id: 'outbox-1', value: { clientMessageId: 'different-id' } },
          view: { accountId: 'account-a', key: ' ', value: null },
          sync_state: { accountId: 'account-a', key: ' ', value: null },
        }
        transaction.objectStore(malformedStore).put(rows[malformedStore])
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  }, { name: DB_NAME, malformedStore, malformedMessage: messageValue({ seq: -1 }) })
}

type CurrentVersionRelationShape =
  | 'missing-message-field'
  | 'message-stream-id'
  | 'missing-message-stream'
  | 'stream-shape'
  | 'message-window-bounds'

async function seedRelationallyMalformedCurrentVersion(page: Page, shape: CurrentVersionRelationShape): Promise<void> {
  const first = messageValue()
  const second = messageValue({ id: 'message-2', seq: 2, content: 'second' })
  await page.evaluate(async ({ name, shape, first, second }) => {
    const keyPaths: Record<string, string[]> = {
      identity: ['accountId', 'id'], chat: ['accountId', 'id'], membership: ['accountId', 'chatId', 'identityId'],
      message: ['accountId', 'id'], stream: ['accountId', 'id'], presence: ['accountId', 'identityId'],
      outbox: ['accountId', 'id'], view: ['accountId', 'key'], sync_state: ['accountId', 'key'],
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 4)
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => {
        for (const [storeName, keyPath] of Object.entries(keyPaths)) {
          const store = request.result.createObjectStore(storeName, { keyPath })
          store.createIndex('accountId', 'accountId')
          if (storeName === 'message') {
            store.createIndex('accountChatSeq', ['accountId', 'chatId', 'seq'])
            store.createIndex('accountStreamSeq', ['accountId', 'streamId', 'seq'])
          }
          if (storeName === 'membership') store.createIndex('accountChat', ['accountId', 'chatId'])
        }
      }
      request.onsuccess = () => resolve(request.result)
    })
    const transaction = database.transaction(['message', 'stream', 'view'], 'readwrite')
    const messageStore = transaction.objectStore('message')
    const streamStore = transaction.objectStore('stream')
    if (shape === 'missing-message-field') {
      const { reactions: _missing, ...missingField } = first
      messageStore.put({ accountId: 'account-a', id: 'message-1', chatId: 'chat-1', streamId: 'main:chat-1', seq: 1, value: missingField })
      streamStore.put({ accountId: 'account-a', id: 'main:chat-1', chatId: 'chat-1', kind: 'main', rootMessageId: null })
    } else if (shape === 'message-stream-id') {
      messageStore.put({ accountId: 'account-a', id: 'message-1', chatId: 'chat-1', streamId: 'main:chat-2', seq: 1, value: first })
      streamStore.put({ accountId: 'account-a', id: 'main:chat-2', chatId: 'chat-2', kind: 'main', rootMessageId: null })
    } else if (shape === 'missing-message-stream') {
      messageStore.put({ accountId: 'account-a', id: 'message-1', chatId: 'chat-1', streamId: 'main:chat-1', seq: 1, value: first })
    } else if (shape === 'stream-shape') {
      streamStore.put({ accountId: 'account-a', id: 'thread:chat-1:root-1', chatId: 'chat-1', kind: 'main', rootMessageId: null })
    } else {
      messageStore.put({ accountId: 'account-a', id: 'message-1', chatId: 'chat-1', streamId: 'main:chat-1', seq: 1, value: first })
      messageStore.put({ accountId: 'account-a', id: 'message-2', chatId: 'chat-1', streamId: 'main:chat-1', seq: 2, value: second })
      streamStore.put({ accountId: 'account-a', id: 'main:chat-1', chatId: 'chat-1', kind: 'main', rootMessageId: null })
      transaction.objectStore('view').put({
        accountId: 'account-a', key: 'message-window:chat-1',
        value: { oldestSeq: 1, maxSeq: 99, hasMoreOlder: false },
      })
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  }, { name: DB_NAME, shape, first, second })
}
