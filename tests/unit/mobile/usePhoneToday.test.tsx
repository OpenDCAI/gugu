// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneToday } from '../../../apps/desktop/src/mobile/assistant/usePhoneToday'
import type { TodayFeedView } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-today-feed'
import { TODAY_REFRESH_MS } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-today-file'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/chatFolder', () => ({ readChatFolderText: mocks.read }))

let latest: TodayFeedView | null = null
function Probe({ chatId }: { chatId: string }) {
  latest = usePhoneToday(chatId)
  return null
}
const file = (title: string) => ({ text: JSON.stringify({ version: 1, widgets: [{ id: title, title }] }), updatedAt: title })

describe('phone Today reads', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.read.mockReset()
    harness = createReactHarness()
    latest = null
  })
  afterEach(() => { harness.cleanup(); vi.useRealTimers() })

  it('hides the previous chat immediately and ignores its late response', async () => {
    const old = deferred<ReturnType<typeof file>>()
    const current = deferred<ReturnType<typeof file>>()
    mocks.read.mockResolvedValueOnce(file('old')).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await harness.render(createNode(Probe, { chatId: 'one' }))
    expect(latest).toMatchObject({ state: 'read', read: { state: 'ok', updatedAt: 'old' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS) })
    await harness.render(createNode(Probe, { chatId: 'two' }))
    expect(latest).toMatchObject({ state: 'loading' })
    await act(async () => { old.resolve(file('late old')) })
    expect(latest).toMatchObject({ state: 'loading' })
    await act(async () => { current.resolve(file('new')) })
    expect(latest).toMatchObject({ state: 'read', read: { state: 'ok', updatedAt: 'new' } })
  })

  it('does not overlap a slow initial read or a slow poll', async () => {
    const first = deferred<ReturnType<typeof file>>()
    const second = deferred<ReturnType<typeof file>>()
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await harness.render(createNode(Probe, { chatId: 'one' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS * 3) })
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve(file('one')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS * 3) })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(latest).toMatchObject({ state: 'read', read: { updatedAt: 'one' } })
  })

  it('shows read failures and lets retry recover without treating them as empty', async () => {
    mocks.read.mockRejectedValueOnce(new Error('file service unavailable')).mockResolvedValueOnce(null)
    await harness.render(createNode(Probe, { chatId: 'one' }))
    expect(latest).toMatchObject({ state: 'error' })
    await act(async () => { if (latest?.state === 'error') latest.retry() })
    expect(latest).toMatchObject({ state: 'read', read: { state: 'none' } })
  })
})
