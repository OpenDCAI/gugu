// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineAfterResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneTaskSend', () => ({ sendPhoneTaskText: vi.fn() }))
import { createPhoneTimelineClient } from '../../../../apps/desktop/src/mobile/local-agent/phoneTimelineClient'

const cursor = { epoch: 'phone-epoch', seq: 1 }
const snapshot: TimelineSnapshot = { cursor, turns: [], settlements: [], hasOlder: false }
const after = (seq: number): TimelineAfterResult => ({ ok: true, batch: { from: 1, cursor: { ...cursor, seq }, turns: [], removedTurnIds: [], settlements: [] } })
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('phone cursor transport', () => {
  it('polls serially from the returned cursor and drops late replies after unsubscribe', async () => {
    let reply!: (value: TimelineAfterResult) => void
    const invoke = vi.fn().mockReturnValueOnce(new Promise((resolve) => { reply = resolve })).mockResolvedValue(after(3))
    const client = createPhoneTimelineClient(invoke)
    const event = vi.fn()
    const stop = client.subscribeSessionEvents('phone', 'sub', event)
    await client.subscribeSession('phone', 'task', 'sub', cursor)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    reply(after(2)); await flush()
    await vi.advanceTimersByTimeAsync(800)
    expect(invoke.mock.calls[1][2][0].cursor).toEqual({ ...cursor, seq: 2 })
    expect(event).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('cannot create a poll if unmounted while the initial cursor is loading', async () => {
    let reply!: (value: TimelineSnapshot) => void
    const invoke = vi.fn().mockReturnValue(new Promise((resolve) => { reply = resolve }))
    const client = createPhoneTimelineClient(invoke)
    const event = vi.fn()
    const stop = client.subscribeSessionEvents('phone', 'sub', event)
    const starting = client.subscribeSession('phone', 'task', 'sub', null)
    stop()
    reply(snapshot); await starting
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(event).not.toHaveBeenCalled()
  })

  it('reports exact permission errors, marks the link and recovers without overlapping foreground polls', async () => {
    const denied = Object.assign(new Error('日历授权已撤回'), { code: 'not_granted' })
    let reply!: (value: TimelineAfterResult) => void
    const invoke = vi.fn().mockRejectedValueOnce(denied).mockReturnValueOnce(new Promise((resolve) => { reply = resolve }))
    const client = createPhoneTimelineClient(invoke)
    const event = vi.fn(), error = vi.fn(), link = vi.fn()
    const stopEvents = client.subscribeSessionEvents('phone', 'sub', event)
    const stopErrors = client.subscribeSessionErrors!('phone', 'sub', error)
    const stopLinks = client.onLinkChange('phone', link)
    await client.subscribeSession('phone', 'task', 'sub', cursor); await flush()
    expect(error).toHaveBeenCalledWith(denied)
    expect(link).toHaveBeenCalledWith(false)
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('online'))
    await flush()
    expect(invoke).toHaveBeenCalledTimes(2)
    reply(after(2)); await flush()
    expect(link.mock.calls).toEqual([[false], [true]])
    stopEvents(); stopErrors(); stopLinks()
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not deliver a previous subscription reply into a replacement with the same id', async () => {
    let old!: (value: TimelineAfterResult) => void
    const invoke = vi.fn().mockReturnValueOnce(new Promise((resolve) => { old = resolve })).mockResolvedValue(after(8))
    const client = createPhoneTimelineClient(invoke), event = vi.fn()
    const stop = client.subscribeSessionEvents('phone', 'sub', event)
    await client.subscribeSession('phone', 'old-task', 'sub', cursor)
    await client.subscribeSession('phone', 'new-task', 'sub', cursor); await flush()
    old(after(2)); await flush()
    expect(event).toHaveBeenCalledTimes(1)
    expect(event).toHaveBeenCalledWith(after(8))
    stop()
  })
})
