// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { queryClient } from '../../../../apps/desktop/src/session/renderer/lib/query-client'
import { AccountSection } from '../../../../apps/desktop/src/components/settings/AccountSection'

const control = vi.hoisted(() => ({ failed: false }))
vi.mock('../../../../apps/desktop/src/lib/firstRun', () => ({
  readOccupation: async () => null,
  writeOccupation: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/billing', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../apps/desktop/src/lib/billing')>()),
  getMembership: async () => {
    if (control.failed) throw new Error('membership offline')
    return { tier: 'max', expiresAt: new Date('2026-11-29T00:00:00Z') }
  },
  useSpendingPower: () => ({
    power: { spendable: 176, periodCredits: 176, walletCredits: 0, held: 0 },
    balanceError: null, windowsError: null, activityRevision: 0,
    windows: { period_credits: 176, period_used: 0, period_started_at: '2026-10-30T00:00:00Z', period_ends_at: '2026-11-29T00:00:00Z', outstanding_credits: 0, credits_per_usd: 1 },
  }),
}))

beforeEach(() => { control.failed = false; queryClient.clear() })
async function render(mobile: boolean) {
  const harness = createReactHarness()
  const user = { id: 'membership-986', email: 'u@example.test', nickname: 'Tester' }
  await renderWithAppProviders(harness, createNode(AccountSection, { user, mobile, updateUser: vi.fn(), logout: vi.fn(async () => ({ success: true })) }), { auth: user })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return harness
}

it('手机账户页复用会员行，无需桌面设置的 QueryClientProvider 或宿主 RPC', async () => {
  const harness = await render(true)
  try {
    const row = harness.container.querySelector('[data-testid="subscription-row-gugu"]')
    expect(row).not.toBeNull()
    expect(row?.querySelector('.subscription-plan-badge')?.textContent).toBe('Max')
    expect(row?.textContent).toContain('2026年11月29日')
    expect(row?.textContent).toContain('176')
    expect(row?.querySelector('a')?.getAttribute('href')).toMatch(/^https:/)
    expect(row?.textContent).toContain('每 30 天为一个周期')
  } finally { harness.cleanup() }
})

it('手机账户页先显示资料说明、资料编辑和保存，再显示会员行', async () => {
  const harness = await render(true)
  try {
    const intro = harness.container.querySelector('.gg-settings-note')!
    const name = harness.container.querySelector('#settings-account-name')!
    const save = harness.container.querySelector('.gg-settings-actions')!
    const membership = harness.container.querySelector('[data-testid="subscription-row-gugu"]')!
    expect(intro.textContent).toBe('头像、名称和简介是别人在咕咕里看到的你。')
    expect(intro.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(name.compareDocumentPosition(membership) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    expect(save.compareDocumentPosition(membership) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  } finally { harness.cleanup() }
})

it('桌面账户页不重复放会员行，保留在订阅页', async () => {
  const harness = await render(false)
  try { expect(harness.container.querySelector('[data-testid="subscription-row-gugu"]')).toBeNull() }
  finally { harness.cleanup() }
})

it('手机会员读取失败如实显示，不冒充 Free 或 Max', async () => {
  control.failed = true
  const harness = await render(true)
  try {
    const row = harness.container.querySelector('[data-testid="subscription-row-gugu"]')
    expect(row?.textContent).toContain('membership offline')
    expect(row?.querySelector('.subscription-plan-badge')).toBeNull()
  } finally { harness.cleanup() }
})
