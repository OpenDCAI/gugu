import { describe, expect, it, vi } from 'vitest'
import { startTaskExchangeReader, type TaskExchangeTransport } from '../../../../apps/desktop/src/lib/taskExchangeReader'
import type { TaskExchangePage } from '../../../../apps/desktop/src/session/shared/core/sessions/task-collaboration'

function rig() {
  const pages = new Map<string, (page: TaskExchangePage) => void>()
  let link = (_open: boolean) => {}
  const transport: TaskExchangeTransport = {
    read: vi.fn(async () => ({ entries: [], cursor: 2, hasMore: false })),
    subscribe: vi.fn(async () => ({ entries: [], cursor: 1, hasMore: false })),
    unsubscribe: vi.fn(async () => {}),
    onPage: (id, receive) => { pages.set(id, receive); return () => { pages.delete(id) } },
    onLink: (changed) => { link = changed; return () => { link = () => {} } },
  }
  return { transport, pages, link: (open: boolean) => link(open), receive: vi.fn(), state: vi.fn() }
}
describe('task collaboration stream lifecycle', () => {
  it('returns from a task safely when the unavailable native bridge throws synchronously during unsubscribe', async () => {
    const r = rig()
    vi.mocked(r.transport.unsubscribe).mockImplementation(() => { throw new Error('electronAPI.invoke is unavailable for sessionTimeline.taskExchangesUnsubscribe') })
    const stop = startTaskExchangeReader(r.transport, { conversationId: 'task', fromSessionId: 'assistant' }, r.receive, r.state)
    await vi.waitFor(() => expect(r.state).toHaveBeenLastCalledWith('ready'))
    expect(() => { stop(); stop() }).not.toThrow()
    await Promise.resolve(); await Promise.resolve()
    expect(r.pages.size).toBe(0)
    expect(r.transport.unsubscribe).toHaveBeenCalledTimes(1)
  })
  it('keeps the read failure visible even if synchronous cleanup fails too', async () => {
    const r = rig()
    vi.mocked(r.transport.subscribe).mockImplementation(() => { throw new Error('native read is unavailable') })
    vi.mocked(r.transport.unsubscribe).mockImplementation(() => { throw new Error('native unsubscribe is unavailable') })
    const stop = startTaskExchangeReader(r.transport, { conversationId: 'task', fromSessionId: 'assistant' }, r.receive, r.state)
    await vi.waitFor(() => expect(r.state).toHaveBeenLastCalledWith('unavailable', expect.objectContaining({ message: 'native read is unavailable' })))
    expect(r.receive).not.toHaveBeenCalled()
    expect(r.pages.size).toBe(0)
    expect(stop).not.toThrow()
  })
  it('installs the push listener before asking for history and reads all pages', async () => {
    const r = rig()
    vi.mocked(r.transport.subscribe).mockImplementation(async ({ subscriptionId }) => {
      expect(r.pages.has(subscriptionId)).toBe(true)
      return { entries: [], cursor: 1, hasMore: true }
    })
    const stop = startTaskExchangeReader(r.transport, { conversationId: 'task', fromSessionId: 'assistant' }, r.receive, r.state)
    await vi.waitFor(() => expect(r.state).toHaveBeenLastCalledWith('ready'))
    expect(r.transport.read).toHaveBeenCalledWith({ conversationId: 'task', fromSessionId: 'assistant', after: 1 })
    stop()
    expect(r.pages.size).toBe(0)
  })
  it('resubscribes and fills the gap after a host connection is replaced', async () => {
    const r = rig()
    const stop = startTaskExchangeReader(r.transport, { conversationId: 'task', fromSessionId: 'assistant' }, r.receive, r.state)
    await vi.waitFor(() => expect(r.state).toHaveBeenLastCalledWith('ready'))
    r.link(false)
    expect(r.state).toHaveBeenLastCalledWith('unavailable')
    expect(r.pages.size).toBe(0)
    r.link(true)
    await vi.waitFor(() => expect(r.transport.subscribe).toHaveBeenCalledTimes(2))
    expect(vi.mocked(r.transport.subscribe).mock.calls[1]![0]).toMatchObject({ after: 1 })
    stop()
  })
  it('does not leak a late history response into a different task and removes the late subscription', async () => {
    const r = rig()
    let finish!: (page: TaskExchangePage) => void
    vi.mocked(r.transport.subscribe).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const stop = startTaskExchangeReader(r.transport, { conversationId: 'task', fromSessionId: 'assistant' }, r.receive, r.state)
    stop()
    finish({ entries: [], cursor: 8, hasMore: true })
    await Promise.resolve(); await Promise.resolve()
    expect(r.receive).not.toHaveBeenCalled()
    expect(r.transport.read).not.toHaveBeenCalled()
    expect(r.transport.unsubscribe).toHaveBeenCalledTimes(2)
  })
  it('shows a read failure as unavailable, rather than an empty successful conversation', async () => {
    const r = rig()
    vi.mocked(r.transport.subscribe).mockRejectedValue(new Error('host too old'))
    const stop = startTaskExchangeReader(r.transport, { conversationId: 'task', fromSessionId: 'assistant' }, r.receive, r.state)
    // 读失败把原文交出去(调用方记日志),❌ 吞掉只剩一句「读不到」。
    await vi.waitFor(() => expect(r.state).toHaveBeenLastCalledWith('unavailable', expect.objectContaining({ message: 'host too old' })))
    expect(r.receive).not.toHaveBeenCalled()
    expect(r.pages.size).toBe(0)
    stop()
  })
})
