// @vitest-environment jsdom
// @@@1511 slice3 邀请卡统计:已邀请人数 / 已获得积分读真实 referral_rewards 聚合(getReferralStats)。
// 锁:有数据显真值、取不到(reject)回落 '—'(不造假)。billing 模块整体 mock,不打真 supabase。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReferralCard } from '../../../../apps/desktop/src/components/usage/ReferralCard'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
// billing 模块拆开后只替换会走网络的读取,领域推导与共享订阅点保持真实。
vi.mock('../../../../apps/desktop/src/lib/billing/balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing/balance')>()),
  getCreditsBalance: vi.fn().mockResolvedValue(1000),
  getReferralStats: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/billing/quota', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing/quota')>()),
  getQuotaWindows: vi.fn().mockRejectedValue(new Error('quota windows unavailable')),
}))
vi.mock('../../../../apps/desktop/src/lib/billing/membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing/membership')>()),
  getMembership: vi.fn().mockResolvedValue(null),
}))
import { getReferralStats } from '../../../../apps/desktop/src/lib/billing/balance'
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const auth = { id: 'u1', email: 'u@e.com', nickname: 'U', gugu_number: 100693 }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })
describe('#1511 slice3 邀请卡统计', () => {
  it('已邀请/已获得 显真实聚合值', async () => {
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 2, creditsEarned: 600 })
    await renderWithAppProviders(harness, createNode(ReferralCard), { auth })
    await flush()
    expect(harness.container.querySelector('[data-testid="settings-quota-invited-count"]')?.textContent).toContain('2')
    const earned = harness.container.querySelector('[data-testid="settings-quota-credits-earned"]')?.textContent
    expect(earned).toContain('600')
    expect(earned).toContain('积分')
  })
  it('0 邀请显「0」(诚实,非 —)', async () => {
    vi.mocked(getReferralStats).mockResolvedValue({ invitedCount: 0, creditsEarned: 0 })
    await renderWithAppProviders(harness, createNode(ReferralCard), { auth })
    await flush()
    expect(harness.container.querySelector('[data-testid="settings-quota-invited-count"]')?.textContent).toContain('0')
  })
  it('取不到(reject)→ 回落 —,不造假', async () => {
    vi.mocked(getReferralStats).mockRejectedValue(new Error('network'))
    await renderWithAppProviders(harness, createNode(ReferralCard), { auth })
    await flush()
    expect(harness.container.querySelector('[data-testid="settings-quota-invited-count"]')?.textContent).toContain('—')
  })
})
