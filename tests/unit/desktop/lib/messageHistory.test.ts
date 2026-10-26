import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLocalSyncDb, type LocalImDbAdapter } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, replaceMessageWindow } from '../../../../apps/desktop/src/lib/imRepository'
import { readHistoryPage, retainHistoryPage, retainMessageDeletion, mergeHistoryRanges } from '../../../../apps/desktop/src/lib/messageHistory'
import { chat, message } from '../../../support/testHarness'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { fetchChatHistoryPage, restoreChatHistoryAnchor } from '../../../../apps/desktop/src/store/chatWindowPublication'
import { ChatHistoryWindow } from '../../../../apps/desktop/src/store/chatHistoryWindow'

let adapter: LocalImDbAdapter
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  adapter = await openLocalSyncDb(new IDBFactory())
})
afterEach(() => { adapter.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
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


describe('online retained history publication', () => {
  it.each(['group', 'topic'] as const)('opens a covered %s anchor online without waiting for history HTTP', async (kind) => {
    vi.stubGlobal('navigator', { onLine: true })
    const repository = await openImRepository('account', { adapter })
    await repository.transaction((tx) => tx.putChat(kind, chat({ id: kind, kind })))
    const page = rows(Array.from({ length: 40 }, (_, i) => i + 81), kind)
    await retainHistoryPage(repository, { chatId: kind, direction: 'older', cursor: 121, limit: 40 }, page, 40)
    await repository.transaction((tx) => retainMessageDeletion(repository, tx, `${kind}-99`))
    const network = vi.spyOn(chatService, 'getMessages').mockImplementation(() => new Promise(() => {}))
    const byId = vi.spyOn(chatService, 'getMessageById').mockImplementation(() => new Promise(() => {}))
    const window = new ChatHistoryWindow('account'); window.reset(kind)
    expect(await restoreChatHistoryAnchor(window, 'account', `${kind}-100`, async () => repository)).toBe(true)
    expect(window.getSnapshot().messages.map((row) => row.seq)).toEqual(page.filter((row) => row.seq !== 99).map((row) => row.seq))
    expect(window.getSnapshot().hasNewer).toBe(true)
    expect(network).not.toHaveBeenCalled(); expect(byId).not.toHaveBeenCalled()
    repository.close()
  })

  it('downloads an uncertified online page instead of claiming an empty cached result', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    const repository = await openImRepository('account', { adapter })
    await repository.transaction((tx) => tx.putChat('group', chat({ id: 'group', kind: 'group' })))
    const page = rows([100, 101])
    const network = vi.spyOn(chatService, 'getMessages').mockResolvedValue(page)
    const result = await fetchChatHistoryPage('account', async () => repository, true)('group', 'older', 102, 20)
    expect(result).toEqual(page)
    expect(network).toHaveBeenCalledWith('group', 'account', 'loadOlder', 20, 102)
    repository.close()
  })

  it('does not reuse an old certified tail for an authoritative online latest read', async () => {
    vi.stubGlobal('navigator', { onLine: true })
    const repository = await openImRepository('account', { adapter })
    await repository.transaction((tx) => tx.putChat('group', chat({ id: 'group', kind: 'group' })))
    await retainHistoryPage(repository, { chatId: 'group', direction: 'latest', cursor: 0, limit: 20 }, rows([100]), 1)
    const network = vi.spyOn(chatService, 'getMessages').mockResolvedValue(rows([200]))
    const result = await fetchChatHistoryPage('account', async () => repository)('group', 'latest', 0, 20)
    expect(result.map((row) => row.seq)).toEqual([200])
    expect(network).toHaveBeenCalledWith('group', 'account', 'initialLoad', 20)
    repository.close()
  })
})
