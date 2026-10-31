// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, MessageItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb, type LocalImDbAdapter } from '../../../../apps/desktop/src/lib/localSyncDb'
import {
  ackOutboxRecord,
  imSelectors,
  openImRepository,
  putOutboxRecord,
  readChatRows,
  readMessageWindow,
  readOutboxRecords,
  replaceChatRows,
  replaceChatRowsAndIdentities,
  replaceMessageWindow,
  type OutboxRecord,
} from '../../../../apps/desktop/src/lib/imRepository'
import { message as messageFixture } from '../../../support/testHarness'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { readPerfCounters } from '../../../../apps/desktop/src/lib/perfCounters'
function identity(id: string, over: Partial<DisplayIdentity> = {}): DisplayIdentity {
  return {
    id, type: 'human', display_name: id, avatar: null, gugu_number: null, bio: null,
    owner_user_id: null, agent_public: null, desired_status: null, device_id: null,
    category: null, is_official: null, local_path: null,
    created_at: null, updated_at: '2026-08-09T00:00:00.000Z', ...over,
  }
}
function chat(id: string): ChatItem {
  return {
    id,
    kind: 'group',
    status: 'active',
    name: id,
    created_at: '2026-08-09T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    unread_count: 0,
    pinned_message_id: null,
    last_read_seq: 0,
    next_message_seq: 1,
  }
}
function message(id: string, accountId = 'account-a'): MessageItem {
  return messageFixture({
    id,
    chat_id: 'chat-1',
    sender_user_id: accountId,
    seq: 1,
    content: id,
  })
}
function outbox(id: string, accountId: string): OutboxRecord {
  return {
    clientMessageId: id,
    chatId: 'chat-1',
    senderUserId: accountId,
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
  }
}
describe('account-scoped normalized IM repository', () => {
  let adapter: LocalImDbAdapter
  beforeEach(() => {
    window.localStorage.clear()
    adapter = createMemoryLocalSyncDb()
  })
  it('counts started transaction attempts including a rejected mutation', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const before = readPerfCounters().imTransactions
    await repository.transaction(() => undefined)
    await expect(repository.transaction(() => { throw new Error('rejected mutation') })).rejects.toThrow('rejected mutation')
    expect(readPerfCounters().imTransactions - before).toBe(2)
  })
  it('writes nine normalized tables atomically, selects them, and publishes once after commit', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const notifications: string[][] = []
    repository.subscribe(imSelectors.chats, (rows) => notifications.push(rows.map((row) => row.id)))
    await repository.transaction((transaction) => {
      transaction.putIdentity(identity('identity-1', { display_name: 'One' }))
      transaction.putChat('chat-1', chat('chat-1'))
      transaction.putMembership('chat-1', 'identity-1', { role: 'member' })
      transaction.putMessage(message('message-1'))
      transaction.putStream('thread:chat-1:root-1', 'chat-1', 'thread', 'root-1')
      transaction.putPresence('identity-1', { state: 'online' })
      transaction.putOutbox(outbox('pending-1', 'account-a'))
      transaction.putView('active-chat', 'chat-1')
      transaction.putSyncState('cursor', { revision: 7 })
    })
    const snapshot = repository.snapshot()
    expect(snapshot.identity).toHaveLength(1)
    expect(snapshot.chat).toHaveLength(1)
    expect(snapshot.membership).toHaveLength(1)
    expect(snapshot.message).toHaveLength(1)
    expect(snapshot.stream.map((row) => row.id).sort()).toEqual(['main:chat-1', 'thread:chat-1:root-1'])
    expect(snapshot.presence).toHaveLength(1)
    expect(snapshot.outbox).toHaveLength(1)
    expect(snapshot.view).toHaveLength(1)
    expect(snapshot.sync_state).toHaveLength(1)
    expect(notifications).toEqual([[], ['chat-1']])
  })
  it('rolls back a failed transaction without publishing a half snapshot', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    let notifications = 0
    repository.subscribe(imSelectors.identitiesById, () => { notifications += 1 })
    await expect(repository.transaction((transaction) => {
      transaction.putIdentity(identity('not-committed', { display_name: 'No' }))
      throw new Error('stop before commit')
    })).rejects.toThrow('stop before commit')
    expect(repository.snapshot().identity).toEqual([])
    expect(notifications).toBe(1)
  })
  it('isolates equal ids across accounts; close preserves data while reset removes only its account', async () => {
    const repositoryA = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const repositoryB = await openImRepository('account-b', { adapter, storage: window.localStorage })
    await replaceChatRows(repositoryA, [{ ...chat('same-id'), name: 'A' }])
    await replaceChatRows(repositoryB, [{ ...chat('same-id'), name: 'B' }])
    repositoryA.close()
    const reopenedA = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readChatRows(reopenedA)[0].name).toBe('A')
    expect(readChatRows(repositoryB)[0].name).toBe('B')
    await reopenedA.reset()
    expect(readChatRows(reopenedA)).toEqual([])
    expect(readChatRows(repositoryB)[0].name).toBe('B')
  })
  it('publishes changed canonical fields even when updated_at is equal', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const seen: string[] = []
    repository.subscribe(imSelectors.identitiesById, (value) => seen.push(value['identity-1']?.display_name ?? 'missing'))
    await repository.transaction((transaction) => transaction.putIdentity(
      identity('identity-1', { display_name: 'Before', avatar: 'https://cdn.example/before.png' }),
    ))
    await repository.transaction((transaction) => transaction.putIdentity(
      identity('identity-1', { display_name: 'After', avatar: 'https://cdn.example/after.png' }),
    ))
    expect(seen).toEqual(['missing', 'Before', 'After'])
    expect(imSelectors.identitiesById(repository.snapshot())['identity-1']?.avatar).toBe('https://cdn.example/after.png')
  })
  it('publishes chats and their display identities in one repository snapshot', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const snapshots: Array<{ chats: number; identities: number }> = []
    repository.subscribe((snapshot) => ({ chats: snapshot.chat.length, identities: snapshot.identity.length }), (value) => snapshots.push(value))
    await replaceChatRowsAndIdentities(repository, [
      { ...chat('chat-1'), kind: 'dm', peer_user_id: 'identity-1' },
    ], [identity('identity-1')])
    expect(snapshots).toEqual([{ chats: 0, identities: 0 }, { chats: 1, identities: 1 }])
  })
  it.each(['chats', 'chats and identities'])('persists a complete %s snapshot beyond 300 conversations', async (kind) => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const rows = Array.from({ length: 420 }, (_, index) => chat(`chat-${index}`))
    if (kind === 'chats') await replaceChatRows(repository, rows)
    else await replaceChatRowsAndIdentities(repository, rows, [])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readChatRows(reopened).map((row) => row.id)).toEqual(rows.map((row) => row.id))
  })
  it('keeps outbox durable across reopen and atomically replaces it with the acknowledged message', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await putOutboxRecord(repository, outbox('message-1', 'account-a'))
    repository.close()
    const recovered = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readOutboxRecords(recovered).map((row) => row.clientMessageId)).toEqual(['message-1'])
    await ackOutboxRecord(recovered, 'message-1', message('message-1'))
    expect(readOutboxRecords(recovered)).toEqual([])
    expect(imSelectors.messagesForChat('chat-1')(recovered.snapshot()).map((row) => row.id)).toEqual(['message-1'])
  })
  it('computes concurrent out-of-order ack bounds from the latest queued snapshot', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const mainFive = { ...message('message-5'), seq: 5 }
    const mainSeven = { ...message('message-7'), seq: 7 }
    const mainSix = { ...message('message-6'), seq: 6 }
    await replaceMessageWindow(repository, 'chat-1', [mainFive], true)
    await repository.transaction((transaction) => {
      transaction.putOutbox(outbox('message-7', 'account-a'))
      transaction.putOutbox(outbox('message-6', 'account-a'))
    })
    const ackSeven = ackOutboxRecord(repository, 'message-7', mainSeven)
    const ackSix = ackOutboxRecord(repository, 'message-6', mainSix)
    await Promise.all([ackSeven, ackSix])
    repository.close()
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect({
      cursor: imSelectors.view('message-window:chat-1')(reopened.snapshot()),
      seqs: readMessageWindow(reopened, 'chat-1')?.messages.map((row) => row.seq),
      outbox: readOutboxRecords(reopened).length,
    }).toEqual({
      cursor: { oldestSeq: 5, maxSeq: 7, hasMoreOlder: true },
      seqs: [5, 6, 7],
      outbox: 0,
    })
  })
  it('rejects an outbox row owned by another account', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await expect(putOutboxRecord(repository, outbox('foreign', 'account-b'))).rejects.toThrow('outbox account mismatch')
    expect(readOutboxRecords(repository)).toEqual([])
  })
  it('rejects a delete keyed to another account without touching that account', async () => {
    const repositoryA = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const repositoryB = await openImRepository('account-b', { adapter, storage: window.localStorage })
    await replaceChatRows(repositoryB, [chat('shared-id')])
    await expect(repositoryA.transaction((transaction) => {
      transaction.delete('chat', ['account-b', 'shared-id'])
    })).rejects.toThrow('delete crossed account boundary')
    expect(readChatRows(repositoryB).map((row) => row.id)).toEqual(['shared-id'])
  })
  it('isolates throwing observers from durable commit and atomic outbox ack', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await putOutboxRecord(repository, outbox('message-1', 'account-a'))
    let throwOnPublish = false
    const healthySnapshots: number[] = []
    repository.subscribe(imSelectors.outbox, () => {
      if (throwOnPublish) throw new Error('observer exploded')
    })
    repository.subscribe(imSelectors.outbox, (rows) => healthySnapshots.push(rows.length))
    throwOnPublish = true
    let ackError = ''
    try {
      await ackOutboxRecord(repository, 'message-1', message('message-1'))
    } catch (error) {
      ackError = error instanceof Error ? error.message : String(error)
    }
    const committedBeforeReopen = {
      outbox: readOutboxRecords(repository).map((row) => row.clientMessageId),
      messages: imSelectors.messagesForChat('chat-1')(repository.snapshot()).map((row) => row.id),
    }
    repository.close()
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect({
      ackError,
      healthySnapshots,
      committedBeforeReopen,
      reopened: {
        outbox: readOutboxRecords(reopened).map((row) => row.clientMessageId),
        messages: imSelectors.messagesForChat('chat-1')(reopened.snapshot()).map((row) => row.id),
      },
    }).toEqual({
      ackError: '',
      healthySnapshots: [1, 0],
      committedBeforeReopen: { outbox: [], messages: ['message-1'] },
      reopened: { outbox: [], messages: ['message-1'] },
    })
  })
  it('does not allow nested selector values to mutate the committed snapshot', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await repository.transaction((transaction) => transaction.putIdentity(
      identity('identity-1', { display_name: 'Original' }),
    ))
    const selected = imSelectors.identitiesById(repository.snapshot())['identity-1']!
    expect(() => { selected.display_name = 'Mutated' }).toThrow()
    expect(selected.display_name).toBe('Original')
  })
  it('hands identities and chats back unchanged when a write does not touch their tables', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await replaceChatRowsAndIdentities(repository, [chat('chat-1')], [identity('identity-1')])
    const identities: unknown[] = []
    const chats: unknown[] = []
    repository.subscribe(imSelectors.identitiesById, (value) => identities.push(value))
    repository.subscribe(imSelectors.chats, (value) => chats.push(value))
    // a sync cursor / view write (what most transactions are) and a message write
    await repository.transaction((transaction) => {
      transaction.putSyncState('cursor', { revision: 8 })
      transaction.putView('active-chat', 'chat-1')
    })
    await repository.transaction((transaction) => transaction.putMessage(message('message-1')))
    expect(identities).toHaveLength(3)
    expect(identities[1]).toBe(identities[0])
    expect(identities[2]).toBe(identities[0])
    expect(chats[2]).toBe(chats[0])
    // writing a row again with the same value is not a change (every message re-puts its sender)
    await repository.transaction((transaction) => transaction.putIdentity(identity('identity-1')))
    expect(identities).toHaveLength(4)
    expect(identities[3]).toBe(identities[0])
    // writing the table again yields a new value
    await repository.transaction((transaction) => transaction.putIdentity(identity('identity-2')))
    expect(identities[4]).not.toBe(identities[0])
    expect(Object.keys(identities[4] as object)).toEqual(['identity-1', 'identity-2'])
    expect(chats[4]).toBe(chats[0])
  })
  it('persists only the entering and leaving rows of a 120-message window', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const messages = Array.from({ length: 120 }, (_, index) => ({ ...message(`m-${index + 1}`), seq: index + 1 }))
    await replaceMessageWindow(repository, 'chat-1', messages, true)
    const before = repository.snapshot()
    const commit = vi.spyOn(adapter, 'commit')
    await replaceMessageWindow(repository, 'chat-1', structuredClone(messages), true)
    expect(commit.mock.calls[0][0]).toEqual([])
    expect(repository.snapshot().message).toBe(before.message)
    expect(repository.snapshot().stream).toBe(before.stream)
    expect(repository.snapshot().view).toBe(before.view)

    const next = [...messages.slice(1), { ...message('m-121'), seq: 121 }]
    await replaceMessageWindow(repository, 'chat-1', next, true)
    expect(commit.mock.calls[1][0]).toEqual([
      { type: 'delete', store: 'message', key: ['account-a', 'm-1'] },
      { type: 'put', store: 'message', value: expect.objectContaining({ id: 'm-121', seq: 121 }) },
      { type: 'put', store: 'view', value: expect.objectContaining({ value: { oldestSeq: 2, maxSeq: 121, hasMoreOlder: true } }) },
    ])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readMessageWindow(reopened, 'chat-1')).toEqual({ messages: next, oldestSeq: 2, maxSeq: 121, hasMoreOlder: true })
  })
  it('persists edits, retractions and stream changes without rewriting unchanged streams or other chats', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const main = message('main')
    const thread = { ...message('reply'), seq: 2, thread_root_id: 'root-a' }
    const other = { ...message('other'), chat_id: 'chat-2' }
    await replaceMessageWindow(repository, 'chat-1', [main, thread])
    await replaceMessageWindow(repository, 'chat-2', [other])
    const commit = vi.spyOn(adapter, 'commit')
    const edited = { ...main, content: 'edited', edited_at: '2026-08-09T01:00:00.000Z', retracted_at: '2026-08-10T00:00:00.000Z' }
    const moved = { ...thread, seq: 3, thread_root_id: 'root-b' }
    await replaceMessageWindow(repository, 'chat-1', [edited, moved], true)
    expect(commit.mock.calls[0][0]).toEqual([
      { type: 'delete', store: 'stream', key: ['account-a', 'thread:chat-1:root-a'] },
      { type: 'put', store: 'message', value: expect.objectContaining({ id: 'main', value: edited }) },
      { type: 'put', store: 'stream', value: expect.objectContaining({ id: 'thread:chat-1:root-b', rootMessageId: 'root-b' }) },
      { type: 'put', store: 'message', value: expect.objectContaining({ id: 'reply', streamId: 'thread:chat-1:root-b', seq: 3 }) },
      { type: 'put', store: 'view', value: expect.objectContaining({ value: { oldestSeq: 1, maxSeq: 3, hasMoreOlder: true } }) },
    ])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(imSelectors.messagesForStream('thread:chat-1:root-a')(reopened.snapshot())).toEqual([])
    expect(imSelectors.messagesForStream('thread:chat-1:root-b')(reopened.snapshot())).toEqual([moved])
    expect(readMessageWindow(reopened, 'chat-1')?.messages).toEqual([edited])
    expect(readMessageWindow(reopened, 'chat-2')?.messages).toEqual([other])
  })
  it('removes obsolete messages and streams when a window becomes empty and excludes optimistic or foreign rows', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await replaceMessageWindow(repository, 'chat-1', [message('main'), { ...message('reply'), thread_root_id: 'root' }], true)
    const commit = vi.spyOn(adapter, 'commit')
    await replaceMessageWindow(repository, 'chat-1', [
      { ...message('optimistic'), seq: -1 },
      { ...message('foreign'), chat_id: 'chat-2' },
    ])
    expect(commit.mock.calls[0][0].filter((operation) => operation.type === 'delete')).toHaveLength(4)
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(reopened.snapshot().message).toEqual([])
    expect(reopened.snapshot().stream).toEqual([])
    expect(readMessageWindow(reopened, 'chat-1')).toEqual({ messages: [], oldestSeq: 0, maxSeq: 0, hasMoreOlder: false })
  })
  it.each(['chats', 'chats and identities'])('diffs %s while preserving sorting, removals and read-state projection', async (kind) => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const replace = (chats: ChatItem[]) => kind === 'chats'
      ? replaceChatRows(repository, chats)
      : replaceChatRowsAndIdentities(repository, chats, [identity('identity-1')])
    const rows = [chat('a'), chat('b'), chat('c')]
    await replace(rows)
    const before = repository.snapshot()
    const commit = vi.spyOn(adapter, 'commit')
    await replace(rows.map((row) => ({ ...row, read_state_version: 8 })))
    expect(commit.mock.calls[0][0]).toEqual([])
    expect(repository.snapshot().chat).toBe(before.chat)
    await replace([rows[1], rows[0], rows[2]])
    expect(commit.mock.calls[1][0]).toEqual([
      { type: 'put', store: 'chat', value: expect.objectContaining({ id: 'b', order: 0 }) },
      { type: 'put', store: 'chat', value: expect.objectContaining({ id: 'a', order: 1 }) },
    ])
    expect(readChatRows(repository).map((row) => row.id)).toEqual(['b', 'a', 'c'])
    await replace([rows[1], rows[2]])
    expect(commit.mock.calls[2][0]).toEqual([
      { type: 'delete', store: 'chat', key: ['account-a', 'a'] },
      { type: 'put', store: 'chat', value: expect.objectContaining({ id: 'c', order: 1 }) },
    ])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readChatRows(reopened)).toEqual([rows[1], rows[2]])
    await replace([])
    expect(repository.snapshot().chat).toEqual([])
  })
  it('deduplicates identities before commit but writes real canonical changes with the same timestamp', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const original = identity('identity-1')
    await repository.putIdentities([original])
    const commit = vi.spyOn(adapter, 'commit')
    await repository.putIdentities([original, { ...original }])
    expect(commit.mock.calls[0][0]).toEqual([])
    const updated = { ...original, display_name: 'Changed', avatar: 'https://cdn.example/changed.png' }
    await repository.putIdentities([updated, { ...updated }])
    expect(commit.mock.calls[1][0]).toEqual([
      { type: 'put', store: 'identity', value: { accountId: 'account-a', id: original.id, value: updated } },
    ])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(imSelectors.identitiesById(reopened.snapshot())[original.id]).toEqual(updated)
  })
  it('prepares queued diffs from the latest successful commit and publishes only after durability', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    const observed: string[][] = []
    repository.subscribe(imSelectors.chats, (rows) => observed.push(rows.map((row) => row.name!)))
    const durableCommit = adapter.commit.bind(adapter)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const commit = vi.spyOn(adapter, 'commit').mockImplementationOnce(async (operations) => {
      entered()
      await gate
      await durableCommit(operations)
    })
    const first = replaceChatRows(repository, [chat('a')])
    await started
    const duplicate = replaceChatRows(repository, [chat('a')])
    const last = replaceChatRows(repository, [{ ...chat('a'), name: 'Last' }])
    expect(repository.snapshot().chat).toEqual([])
    expect(observed).toEqual([[]])
    expect(commit).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, duplicate, last])
    expect(commit.mock.calls[1][0]).toEqual([])
    expect(commit.mock.calls[2][0]).toEqual([
      { type: 'put', store: 'chat', value: expect.objectContaining({ id: 'a', value: expect.objectContaining({ name: 'Last' }) }) },
    ])
    expect(observed).toEqual([[], ['a'], ['a'], ['Last']])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readChatRows(reopened)[0].name).toBe('Last')
  })
  it('discards a prepared snapshot on commit failure and lets the next queued replacement retry it', async () => {
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    await replaceChatRowsAndIdentities(repository, [chat('a')], [identity('identity-1')])
    const before = repository.snapshot()
    const seen: unknown[] = []
    repository.subscribe((snapshot) => snapshot, (snapshot) => seen.push(snapshot))
    const commit = vi.spyOn(adapter, 'commit').mockRejectedValueOnce(new Error('disk failure'))
    const updated = identity('identity-1', { display_name: 'Changed' })
    await expect(replaceChatRowsAndIdentities(repository, [chat('b')], [updated])).rejects.toThrow('disk failure')
    expect(repository.snapshot()).toBe(before)
    expect(seen).toEqual([before])
    await replaceChatRowsAndIdentities(repository, [chat('b')], [updated])
    expect(commit.mock.calls[1][0]).toEqual(commit.mock.calls[0][0])
    const reopened = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readChatRows(reopened)).toEqual([chat('b')])
    expect(imSelectors.identitiesById(reopened.snapshot())['identity-1']).toEqual(updated)
    expect(seen).toHaveLength(2)
  })
})
describe('legacy chat-list migration', () => {
  beforeEach(() => window.localStorage.clear())
  it('migrates only the exact account key, re-reads canonical order, then deletes that key', async () => {
    const adapter = createMemoryLocalSyncDb()
    window.localStorage.setItem('gugu.chatListCache.v2:account-a', JSON.stringify([chat('a-2'), chat('a-1')]))
    window.localStorage.setItem('gugu.chatListCache.v2:account-b', JSON.stringify([chat('b-1')]))
    const repository = await openImRepository('account-a', { adapter, storage: window.localStorage })
    expect(readChatRows(repository).map((row) => row.id)).toEqual(['a-2', 'a-1'])
    expect(window.localStorage.getItem('gugu.chatListCache.v2:account-a')).toBeNull()
    expect(window.localStorage.getItem('gugu.chatListCache.v2:account-b')).not.toBeNull()
  })
  it.each([
    ['malformed JSON', '{bad json', 'not valid JSON'],
    ['invalid row shape', JSON.stringify([{ id: 'chat-1', kind: 'group' }]), 'invalid row shape'],
  ])('fails loudly and preserves %s byte-for-byte', async (_label, raw, error) => {
    const adapter = createMemoryLocalSyncDb()
    window.localStorage.setItem('gugu.chatListCache.v2:account-a', raw)
    await expect(openImRepository('account-a', { adapter, storage: window.localStorage })).rejects.toThrow(error)
    expect(window.localStorage.getItem('gugu.chatListCache.v2:account-a')).toBe(raw)
  })
  it('retains legacy bytes and rejects when the post-write shadow differs', async () => {
    const backing = createMemoryLocalSyncDb()
    const adapter: LocalImDbAdapter = {
      ...backing,
      async loadAccount(accountId) {
        const rows = await backing.loadAccount(accountId)
        if (rows.chat.length > 0) {
          const row = rows.chat[0] as unknown as { value: ChatItem }
          row.value = { ...row.value, name: 'mismatch' }
        }
        return rows
      },
    }
    window.localStorage.setItem('gugu.chatListCache.v2:account-a', JSON.stringify([chat('a-1')]))
    await expect(openImRepository('account-a', { adapter, storage: window.localStorage })).rejects.toThrow('shadow mismatch')
    expect(window.localStorage.getItem('gugu.chatListCache.v2:account-a')).not.toBeNull()
  })
})
