import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLocalSyncDb, type LocalImDbAdapter } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, replaceMessageWindow } from '../../../../apps/desktop/src/lib/imRepository'
import { readHistoryPage, retainHistoryPage, retainMessageDeletion, mergeHistoryRanges } from '../../../../apps/desktop/src/lib/messageHistory'
import { message } from '../../../support/testHarness'

let adapter: LocalImDbAdapter
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  adapter = await openLocalSyncDb(new IDBFactory())
})
afterEach(() => { adapter.close(); vi.unstubAllGlobals() })
const rows = (seqs: number[], chatId = 'group') => seqs.map((seq) => message({ id: `${chatId}-${seq}`, chat_id: chatId, seq }))

describe('durable sparse history', () => {
  it('reopens bounded resident rows while retaining separated history pages on disk', async () => {
    const repository = await openImRepository('account', { adapter })
    const query = { chatId: 'group', direction: 'older' as const, cursor: 102, limit: 3 }
    const older = rows([97, 99, 101]) // legal holes are covered by the authoritative page
    await retainHistoryPage(repository, query, older, 3)
    await retainHistoryPage(repository, { ...query, cursor: 8002 }, rows([7997, 7999, 8001]), 3)
    await replaceMessageWindow(repository, 'group', rows([9999, 10000]), true)
    repository.close()
    const reopened = await openImRepository('account', { adapter })
    expect(reopened.snapshot().message.map((row) => row.seq).sort((a, b) => a - b)).toEqual([9999, 10000])
    expect(await readHistoryPage(reopened, query)).toEqual(older)
    expect(await readHistoryPage(reopened, { ...query, cursor: 4002 })).toBeNull()
    expect(await readHistoryPage(reopened, { ...query, chatId: 'topic' })).toBeNull()
    const other = await openImRepository('other-account', { adapter })
    expect(await readHistoryPage(other, query)).toBeNull()
  })

  it('does not resurrect an archived deletion when an older network response arrives late', async () => {
    const repository = await openImRepository('account', { adapter })
    const query = { chatId: 'topic', direction: 'older' as const, cursor: 50, limit: 3 }
    const page = rows([1, 10], 'topic')
    await retainHistoryPage(repository, query, page, 2)
    await repository.transaction((tx) => retainMessageDeletion(repository, tx, page[1]!.id))
    await retainHistoryPage(repository, query, page, 2)
    await replaceMessageWindow(repository, 'topic', page)
    const reopened = await openImRepository('account', { adapter })
    expect((await readHistoryPage(reopened, query))?.map((row) => row.id)).toEqual(['topic-1'])
    expect(await reopened.readMessage('topic-10')).toBeUndefined()
  })

  it('evicts the displayed tail without deleting its stored bodies or claiming intervening holes', async () => {
    const repository = await openImRepository('account', { adapter })
    await replaceMessageWindow(repository, 'group', rows([10, 11]), true)
    await replaceMessageWindow(repository, 'group', rows([9999, 10000]), true)
    const reopened = await openImRepository('account', { adapter })
    expect(reopened.snapshot().message.map((row) => row.seq).sort((a, b) => a - b)).toEqual([9999, 10000])
    expect((await reopened.readMessage('group-10'))?.value.seq).toBe(10)
    expect(await readHistoryPage(reopened, { chatId: 'group', direction: 'older', cursor: 12, limit: 2 })).toBeNull()
  })

  it('keeps a covered historical page usable after a confirmed deletion shortens it', async () => {
    const repository = await openImRepository('account', { adapter })
    const query = { chatId: 'group', direction: 'older' as const, cursor: 104, limit: 3 }
    const page = rows([101, 102, 103])
    await retainHistoryPage(repository, query, page, 3)
    await repository.transaction((tx) => retainMessageDeletion(repository, tx, 'group-102'))
    expect((await readHistoryPage(repository, query))?.map((row) => row.seq)).toEqual([101, 103])
    expect(await readHistoryPage(repository, { ...query, cursor: 101 })).toBeNull()
  })

  it('commits no coverage if an authoritative row could not be mapped', async () => {
    const repository = await openImRepository('account', { adapter })
    const query = { chatId: 'group', direction: 'older' as const, cursor: 102, limit: 3 }
    await expect(retainHistoryPage(repository, query, rows([100, 101]), 3)).rejects.toThrow('unmapped')
    expect(await readHistoryPage(repository, query)).toBeNull()
  })

  it('merges only touching intervals and returns proven empty pages at the observed tail', async () => {
    expect(mergeHistoryRanges([{ lower: 1, upper: 10 }, { lower: 50, upper: 60 }], { lower: 11, upper: 20 }))
      .toEqual([{ lower: 1, upper: 20 }, { lower: 50, upper: 60 }])
    const repository = await openImRepository('account', { adapter })
    await retainHistoryPage(repository, { chatId: 'group', direction: 'newer', cursor: 101, limit: 3 }, [], 0)
    expect(await readHistoryPage(repository, { chatId: 'group', direction: 'newer', cursor: 101, limit: 3 })).toEqual([])
  })
})
