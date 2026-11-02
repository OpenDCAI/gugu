import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalUsageSnapshot } from '@gugu/core/shared/usage/dailyUsage'
import { USAGE_FIRST_DELAY_MS, USAGE_SYNC_INTERVAL_MS } from '@gugu/core/shared/usage/sync'

const cloud = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('@gugu/core/cloud/usageDaily', () => ({ replaceUsageDeviceRows: (...args: unknown[]) => cloud.replace(...args) }))
import { startServerUsageSync } from '../../../../apps/desktop/electron/server/usage-sync'

describe('headless device usage sync', () => {
  let dir: string
  let stop: (() => void) | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gugu-usage-1351-'))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
    cloud.replace.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => { stop?.(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) })
  function setup() {
    const requests: Array<{ from: string; to: string }> = []
    const snapshot = vi.fn(async (request: { from: string; to: string }): Promise<LocalUsageSnapshot> => {
      requests.push(request)
      return { ...request, engines: [], device: [] }
    })
    const options = { userData: dir, identity: async () => ({ userId: 'owner', deviceId: 'server-install' }), snapshot, client: {} as never, report: vi.fn() }
    stop = startServerUsageSync(options)
    return { options, requests, snapshot }
  }
  const span = (r: { from: string; to: string }) => Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1

  it('starts without a renderer, syncs full history then recent eight days every 30 minutes', async () => {
    const { requests } = setup()
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS - 1)
    expect(requests).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(requests.map(span)).toEqual([400])
    await vi.advanceTimersByTimeAsync(USAGE_SYNC_INTERVAL_MS - USAGE_FIRST_DELAY_MS)
    expect(requests.map(span)).toEqual([400, 8])
    expect(cloud.replace.mock.calls.every(call => call[2] === 'server-install')).toBe(true)
  })
  it('persists the full-history checkpoint across server restarts', async () => {
    const { options, requests } = setup()
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS)
    expect(JSON.parse(readFileSync(join(dir, 'usage-sync.json'), 'utf8')).state.shape).toBe(2)
    stop!()
    await vi.advanceTimersByTimeAsync(USAGE_SYNC_INTERVAL_MS)
    stop = startServerUsageSync(options)
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS)
    expect(requests.map(span)).toEqual([400, 8])
  })
  it('retries the full range after a cloud failure; failure does not record success', async () => {
    cloud.replace.mockRejectedValueOnce(new Error('offline'))
    const { requests, options } = setup()
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS)
    expect(options.report).toHaveBeenCalledWith('failed', expect.any(Error))
    expect(() => readFileSync(join(dir, 'usage-sync.json'))).toThrow()
    await vi.advanceTimersByTimeAsync(USAGE_SYNC_INTERVAL_MS)
    expect(requests.map(span)).toEqual([400, 400])
  })
  it('does not overlap a scan still running at the next scheduled tick', async () => {
    const { snapshot } = setup()
    let finish!: (snapshot: LocalUsageSnapshot) => void
    snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(USAGE_SYNC_INTERVAL_MS * 2)
    expect(snapshot).toHaveBeenCalledTimes(1)
    finish({ from: '2025-09-29', to: '2026-11-02', engines: [], device: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(cloud.replace).toHaveBeenCalledTimes(1)
  })
  it('stopping during a scan prevents late uploads and cancels all future ticks', async () => {
    const { snapshot } = setup()
    let finish!: (snapshot: LocalUsageSnapshot) => void
    snapshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS)
    stop!()
    finish({ from: '2025-09-29', to: '2026-11-02', engines: [], device: [] })
    await vi.advanceTimersByTimeAsync(USAGE_SYNC_INTERVAL_MS * 2)
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(cloud.replace).not.toHaveBeenCalled()
  })
  it('a different account/device receives its own full checkpoint', async () => {
    const { options, requests } = setup()
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS)
    stop!()
    stop = startServerUsageSync({ ...options, identity: async () => ({ userId: 'other-owner', deviceId: 'other-install' }) })
    await vi.advanceTimersByTimeAsync(USAGE_FIRST_DELAY_MS)
    expect(requests.map(span)).toEqual([400, 400])
  })
})
