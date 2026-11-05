import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { expect, it } from 'vitest'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

it('drops legacy desktop message rows on every opening, preserving delivery queues and phone bodies', async () => {
  const adapter = await openLocalSyncDb(new IDBFactory())
  try {
    // desktop2 sorts right after desktop: the purge's key ranges must stop at the account boundary.
    for (const accountId of ['desktop', 'desktop2', 'phone']) await adapter.commit([
      { type: 'put', store: 'message', value: { accountId, id: 'old', chatId: 'chat', streamId: 'main:chat', seq: 1, value: messageItemFromRow({ id: 'old', chat_id: 'chat', seq: 1, sender_user_id: accountId, content: 'old', content_type: 'text', created_at: '2026-11-03T00:00:00Z' }, accountId) } },
      { type: 'put', store: 'stream', value: { accountId, id: 'main:chat', chatId: 'chat', kind: 'main', rootMessageId: null } },
      { type: 'put', store: 'view', value: { accountId, key: 'message-window:chat', value: { oldestSeq: 1, maxSeq: 1, hasMoreOlder: false } } },
      { type: 'put', store: 'view', value: { accountId, key: 'message-revision:old', value: { revision: '1' } } },
      { type: 'put', store: 'view', value: { accountId, key: 'account-revision-operation:1', value: { revision: '1', event: 'presence_changed', payload: {} } } },
    ])
    await adapter.prepareLocalMessages!('desktop')
    const desktop = await adapter.loadAccount('desktop')
    expect(desktop.message).toEqual([])
    expect(desktop.stream).toEqual([])
    expect(desktop.view.map(row => row.key)).toEqual(['account-revision-operation:1'])
    // Desktop never writes these rows again, so a repeated opening is an idempotent purge.
    await adapter.commit([{ type: 'put', store: 'view', value: { accountId: 'desktop', key: 'message-window:legacy', value: { oldestSeq: 0, maxSeq: 0, hasMoreOlder: false } } }])
    await adapter.prepareLocalMessages!('desktop')
    expect((await adapter.loadAccount('desktop')).view.map(row => row.key)).toEqual(['account-revision-operation:1'])
    const neighbour = await adapter.loadAccount('desktop2')
    expect([neighbour.message.length, neighbour.stream.length, neighbour.view.length]).toEqual([1, 1, 3])
    const phone = await adapter.loadAccount('phone')
    expect(phone.message).toHaveLength(1)
    expect(phone.stream).toHaveLength(1)
  } finally { adapter.close() }
})
