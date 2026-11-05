// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'

const io = vi.hoisted(() => ({ network: vi.fn(), invoke: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getMessages: io.network } }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { localMessages: 'sqlite' } }))
vi.mock('../../../../apps/desktop/src/store/chatDiskWindow', () => ({ seedCacheFromDisk: vi.fn() }))
import { fetchChatHistoryPage } from '../../../../apps/desktop/src/store/chatWindowPublication'

const row = (seq: number) => ({ id: `m${seq}`, chat_id: 'chat', seq } as MessageItem)
const earlier = Array.from({ length: 50 }, (_, i) => row(i + 1))
const missing = Array.from({ length: 29 }, (_, i) => row(i + 51))
const repository = { persistentMessages: true, messagePage: async () => earlier.slice(-30) }

describe('e6: an uncovered interval never silently joins older local history', () => {
  beforeEach(() => {
    console.log('C29_E6_WRITER_CONTROL: known local intervals are [1,50] and [80,130]')
    io.network.mockReset().mockResolvedValue(missing)
    io.invoke.mockReset().mockImplementation(async (channel: string) => {
      if (channel === 'imMessages.page') return { rows: earlier.slice(-30), covered: false }
      throw new Error(`Unexpected RPC ${channel}`)
    })
    Object.assign(window, { electronAPI: { invoke: io.invoke, eventOn: () => () => {} } })
  })

  it('requests the network below 80 instead of returning local 1–50 across the hole', async () => {
    // The old parent accepts a repository argument; the new path queries SQLite directly.
    const fetch = Reflect.apply(fetchChatHistoryPage, undefined, ['account', async () => repository]) as ReturnType<typeof fetchChatHistoryPage>
    const rows = await fetch('chat', 'older', 80, 30)
    expect(io.network).toHaveBeenCalledExactlyOnceWith('chat', 'account', 'loadOlder', 30, 80)
    expect(rows).toEqual(missing)
  })

  it('reports an offline read failure instead of displaying local 1–50', async () => {
    io.network.mockRejectedValueOnce(new Error('Failed to fetch'))
    // The old parent accepts a repository argument; the new path queries SQLite directly.
    const fetch = Reflect.apply(fetchChatHistoryPage, undefined, ['account', async () => repository]) as ReturnType<typeof fetchChatHistoryPage>
    await expect(fetch('chat', 'older', 80, 30)).rejects.toThrow('Failed to fetch')
    expect(io.network).toHaveBeenCalledTimes(1)
  })
})
