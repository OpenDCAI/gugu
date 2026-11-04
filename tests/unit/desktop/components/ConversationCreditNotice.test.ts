// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { publishSelfIdentity } from '@/lib/selfIdentityBridge'

const state = vi.hoisted(() => ({ spendable: 0.999 as number | null, mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ readMobileShell: () => state.mobile }))
vi.mock('../../../../apps/desktop/src/lib/billing', async original => {
  const actual = await original<typeof import('../../../../apps/desktop/src/lib/billing')>()
  return { ...actual, useSpendingPower: () => ({ power: state.spendable === null ? null : { spendable: state.spendable } }) }
})
const { ConversationCreditNotice } = await import('../../../../apps/desktop/src/components/chat/ConversationCreditNotice')
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { publishSelfIdentity({ userId: 'credit-test', displayName: null, guguNumber: null }); harness = createReactHarness(); state.spendable = 0.999; state.mobile = false })
afterEach(() => { harness.cleanup(); publishSelfIdentity(null) })
const render = (modelOptionId = 'platform:test') => harness.render(createElement(ConversationCreditNotice, { modelOptionId }))

it('shows the live spendable total as one quiet composer line and follows balance changes', async () => {
  await render()
  expect(harness.container.textContent).toBe('剩 1 积分 · 充值')
  expect(harness.container.querySelectorAll('button')).toHaveLength(1)
  expect(harness.container.querySelector('svg, [role="alert"]')).toBeNull()
  state.spendable = 0.5
  await render()
  expect(harness.container.textContent).toBe('剩 0.5 积分 · 充值')
})

it.each([null, 0, 1, 2])('does not invent a low-balance reminder for %s spendable credits', async spendable => {
  state.spendable = spendable
  await render()
  expect(harness.container.textContent).toBe('')
})

it.each(['', 'claude-sonnet', 'platform:'])('stays absent for own-account or unknown model %s', async model => {
  await render(model)
  expect(harness.container.textContent).toBe('')
})

it.each([false, true])('opens the real credit page on mobile=%s', async mobile => {
  state.mobile = mobile
  const opened = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, opened)
  try {
    await render()
    await act(async () => { harness.container.querySelector('button')!.click() })
    expect(opened).toHaveBeenCalledOnce()
    expect((opened.mock.calls[0]![0] as CustomEvent).detail.section).toBe(mobile ? 'account' : 'subscriptions')
  } finally { window.removeEventListener(UI_EVENTS.openSettings, opened) }
})
