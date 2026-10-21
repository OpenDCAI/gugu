// @vitest-environment jsdom
// #6334 本机用量上云的范围:第一次全量(400 天),之后只送最近 8 天;上云行的形状变过(例如 Token 分来源)
// 就再全量送一次 —— 否则旧日子的新字段永远是空的,「活跃」页会把整段历史显示成「分不清来源」。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ requests: [] as Array<{ from: string; to: string }> }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    getLocalUsageSnapshot: async (request: { from: string; to: string }) => {
      calls.requests.push(request)
      return { from: request.from, to: request.to, engines: [], device: [] }
    },
    getLocalDeviceSelfSnapshot: async () => ({ device_id: 'dev1' }),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => 'u1' }))
vi.mock('../../../../apps/desktop/src/lib/usage/cloud', () => ({ replaceDeviceRows: async () => {} }))

import { syncLocalUsage } from '../../../../apps/desktop/src/lib/usage/sync'
import { addDays } from '../../../../apps/desktop/src/lib/usage/derive'

const span = (r: { from: string; to: string }) => {
  let n = 1
  for (let d = r.from; d < r.to; d = addDays(d, 1)) n += 1
  return n
}

describe('syncLocalUsage 的范围', () => {
  beforeEach(() => { localStorage.clear(); calls.requests.length = 0 })

  it('第一次全量,之后只送最近 8 天', async () => {
    await syncLocalUsage({ force: true })
    await syncLocalUsage({ force: true })
    expect(calls.requests.map(span)).toEqual([400, 8])
  })

  it('老版本全量过(没有形状版本)→ 再全量送一次,然后回到 8 天', async () => {
    localStorage.setItem('gugu.usage.sync.u1.dev1', JSON.stringify({ fullAt: 1, lastAt: 1 }))
    await syncLocalUsage({ force: true })
    await syncLocalUsage({ force: true })
    expect(calls.requests.map(span)).toEqual([400, 8])
  })
})
