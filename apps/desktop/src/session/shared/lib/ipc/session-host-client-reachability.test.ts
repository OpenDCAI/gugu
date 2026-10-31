import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionHostClient, type SessionHostPipeOpener } from './session-host-client'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

function availability(initial: boolean) {
  let reachable = initial
  let listener: (() => void) | undefined
  return {
    options: {
      isReachable: () => reachable,
      subscribeReachability: (fn: () => void) => { listener = fn; return () => { listener = undefined } },
    },
    set(value: boolean) { reachable = value; listener?.() },
  }
}

describe('task host stops dialing during confirmed sleep', () => {
  it('does not attach while asleep, including foreground and restart reconnects; resumes automatically', async () => {
    vi.useFakeTimers()
    const status = availability(false)
    const open = vi.fn<SessionHostPipeOpener>(async () => ({ send() {}, close() {} }))
    const warn = vi.fn()
    const client = createSessionHostClient(open, { ...status.options, warn })
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'unreachable' })
      client.reconnectNow()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(open).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      status.set(true)
      await flush()
      expect(open).toHaveBeenCalledTimes(1)
      expect(client.state()).toBe('open')
    } finally { client.close() }
  })

  it('closes an existing pipe, stops its heartbeat, and retains subscriptions through sleep', async () => {
    vi.useFakeTimers()
    const status = availability(true)
    const send = vi.fn(), close = vi.fn(), warn = vi.fn()
    const open = vi.fn<SessionHostPipeOpener>(async () => ({ send, close }))
    const client = createSessionHostClient(open, { ...status.options, subscribeEvents: true, heartbeatMs: 5000, warn })
    try {
      client.api.eventOn('session.changed', () => undefined)
      await client.connect()
      status.set(false)
      await flush()
      expect(client.state()).toBe('closed')
      expect(close).toHaveBeenCalledTimes(1)
      const count = send.mock.calls.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(send).toHaveBeenCalledTimes(count)
      expect(open).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
      status.set(true)
      await flush()
      expect(open).toHaveBeenCalledTimes(2)
      expect(send.mock.calls.at(-1)?.[0]).toContain('session.changed')
    } finally { client.close() }
  })

  it('does not start a second attach when another device notification arrives during opening', async () => {
    const status = availability(true)
    let resolve!: (pipe: { send(): void; close(): void }) => void
    const open = vi.fn<SessionHostPipeOpener>(() => new Promise(r => { resolve = r }))
    const client = createSessionHostClient(open, status.options)
    try {
      const opening = client.connect()
      status.set(true)
      expect(open).toHaveBeenCalledTimes(1)
      resolve({ send() {}, close() {} })
      await opening
      expect(client.state()).toBe('open')
    } finally { client.close() }
  })

  it('abandons a pending open on sleep and disposes its late pipe instead of redialing', async () => {
    const status = availability(true)
    let resolve!: (pipe: { send(): void; close(): void }) => void
    const open = vi.fn<SessionHostPipeOpener>(() => new Promise(r => { resolve = r }))
    const client = createSessionHostClient(open, status.options)
    try {
      const opening = client.connect().catch(error => error)
      status.set(false)
      const close = vi.fn()
      resolve({ send() {}, close })
      const error = await opening
      expect(error).toMatchObject({ code: 'unreachable' })
      await flush()
      expect(close).toHaveBeenCalledTimes(1)
      expect(client.state()).toBe('closed')
      expect(open).toHaveBeenCalledTimes(1)
    } finally { client.close() }
  })
})
