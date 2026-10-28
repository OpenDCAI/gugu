// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReferralCard } from '../../../../apps/desktop/src/components/usage/ReferralCard'
import { createReactHarness, clickElement, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'
const rig = vi.hoisted(() => ({ stats: vi.fn(), identities: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/billing', async original => ({ ...(await original<object>()), getReferralStats: rig.stats }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', async original => ({ ...(await original<object>()), readDisplayIdentities: rig.identities }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.stubEnv('VITE_GUGU_WEB_URL', 'https://invites.example.test'); rig.stats.mockReset().mockResolvedValue({ invitedCount: 2, creditsEarned: 10 }); rig.identities.mockReset().mockResolvedValue([{ id: 'u1', gugu_number: 1001 }]) })
afterEach(() => { h.cleanup(); vi.unstubAllEnvs() })
const auth = { id: 'u1', gugu_number: null }
const input = () => h.container.querySelector<HTMLInputElement>('[data-testid="settings-quota-invite-input"]')
const ready = () => waitForCondition(() => !!input(), 'invitation link should load')

it('uses skeletons without disabled actions until the identity number is read', async () => {
  const identity = Promise.withResolvers<{ id: string; gugu_number: number }[]>()
  rig.identities.mockReturnValue(identity.promise)
  await renderWithAppProviders(h, <ReferralCard />, { auth })
  expect(h.container.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(h.container.querySelector('button')).toBeNull()
  expect(h.container.textContent).not.toMatch(/即将|开放/)
  await act(async () => identity.resolve([{ id: 'u1', gugu_number: 1001 }]))
  await ready()
  expect(input()!.value).toContain('ref=1001')
  expect(h.container.querySelector('[aria-busy="true"]')).toBeNull()
})

it('waits for canonical identity provisioning before reading the invitation number', async () => {
  await renderWithAppProviders(h, <ReferralCard />, { auth: { ...auth, identityPending: true } })
  expect(h.container.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(h.container.querySelector('[role="alert"]')).toBeNull()
  expect(rig.identities).not.toHaveBeenCalled()
  await renderWithAppProviders(h, <ReferralCard />, { auth: { ...auth, identityPending: false } })
  await ready()
  expect(input()!.value).toContain('ref=1001')
})

it('combines number and stats failures into one specific inline error and one retry', async () => {
  rig.identities.mockRejectedValueOnce(Error('number unavailable'))
  rig.stats.mockRejectedValueOnce(Error('stats unavailable'))
  const toast = vi.fn()
  await renderWithAppProviders(h, <ReferralCard />, { auth, toast })
  await waitForCondition(() => !!h.container.querySelector('[role="alert"]'), 'read failure should be visible')
  const alerts = h.container.querySelectorAll('[role="alert"]')
  expect(alerts).toHaveLength(1)
  expect(alerts[0].textContent).toContain('邀请信息加载失败')
  expect(h.container.querySelectorAll('button')).toHaveLength(1)
  expect(input()).toBeNull()
  expect(toast).not.toHaveBeenCalled()
  await clickElement(h.container.querySelector('button')!)
  await ready()
  expect(h.container.querySelector('[role="alert"]')).toBeNull()
  expect(rig.identities).toHaveBeenCalledTimes(2)
  expect(rig.stats).toHaveBeenCalledTimes(2)
})

it('retains a working invitation link when only the stats read fails', async () => {
  rig.stats.mockRejectedValue(Error('stats unavailable'))
  await renderWithAppProviders(h, <ReferralCard />, { auth: { ...auth, gugu_number: 1001 } })
  await waitForCondition(() => !!h.container.querySelector('[role="alert"]'), 'stats read failure should be visible')
  expect(input()!.value).toContain('ref=1001')
  const button = [...h.container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('复制邀请链接'))!
  expect(button.disabled).toBe(false)
  expect(rig.identities).not.toHaveBeenCalled()
})

it('rejects a missing canonical number instead of inventing a URL', async () => {
  rig.identities.mockResolvedValue([])
  await renderWithAppProviders(h, <ReferralCard />, { auth })
  await waitForCondition(() => !!h.container.querySelector('[role="alert"]'), 'missing identity should be reported')
  expect(h.container.querySelector('[role="alert"]')!.textContent).toContain('邀请信息加载失败')
  expect(input()).toBeNull()
  expect(h.container.querySelector('[aria-busy="true"]')).toBeNull()
})

it('does not display an earlier account response after switching accounts', async () => {
  const old = Promise.withResolvers<{ id: string; gugu_number: number }[]>()
  const next = Promise.withResolvers<{ id: string; gugu_number: number }[]>()
  rig.identities.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
  await renderWithAppProviders(h, <ReferralCard />, { auth })
  await renderWithAppProviders(h, <ReferralCard />, { auth: { id: 'u2', gugu_number: null } })
  await act(async () => old.resolve([{ id: 'u1', gugu_number: 1001 }]))
  expect(input()).toBeNull()
  await act(async () => next.resolve([{ id: 'u2', gugu_number: 2002 }]))
  await ready()
  expect(input()!.value).toContain('ref=2002')
  expect(input()!.value).not.toContain('1001')
})

it('does not offer a link or copy action without a configured invitation landing page', async () => {
  vi.stubEnv('VITE_GUGU_WEB_URL', '')
  await renderWithAppProviders(h, <ReferralCard />, { auth })
  await waitForCondition(() => !!h.container.querySelector('[data-testid="settings-quota-invited-count"]')?.textContent?.includes('2'), 'stats should load without an invitation URL')
  expect(input()).toBeNull()
  expect(h.container.querySelector('button')).toBeNull()
  expect(h.container.querySelector('.na-referral-link')).toBeNull()
  expect(rig.identities).not.toHaveBeenCalled()
})
