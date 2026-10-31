import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AgentSettingsModal } from '@/components/agentsettings/AgentSettingsModal'
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { i18n } from '@/i18n'
import '@/i18n/registerAgentsCatalog'
import '@/styles/tokens.css'

vi.mock('@/hooks/useAgentDisplayStatus', () => import('../../../../../../../tests/support/agentDisplayStatusTestDouble'))
vi.mock('@/lib/agentScheduledTasks', () => ({ agentScheduledTaskService: { list: async () => [] } }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())
for (const [width, height] of [[1100, 800], [390, 620], [390, 844]]) it(`keeps only save pinned and separates pause from delete (${width}x${height})`, async () => {
  const mobile = width < 600
  await page.viewport(width, height)
  await i18n.changeLanguage('zh-CN')
  await renderWithAppProviders(h, <AgentSettingsModal agent={contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })} />, { auth: { id: 'u1' } })
  if (mobile) await page.getByRole('button', { name: '资料', exact: true }).click()
  await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))
  const modal = document.querySelector('[data-testid="agent-settings-modal"]')!.getBoundingClientRect()
  const actions = document.querySelector<HTMLElement>('[data-testid="agent-profile-actions"]')!
  const content = document.querySelector<HTMLElement>('[data-testid="agent-profile-content"]')!
  const save = document.querySelector('.gg-as-profile-save')!.getBoundingClientRect()
  const pause = content.querySelector<HTMLButtonElement>('[role="switch"]')!
  const pauseRow = content.querySelector<HTMLElement>('[data-testid="agent-profile-pause"]')!
  const remove = content.querySelector<HTMLElement>('.gg-as-profile-danger')!
  expect(save.bottom).toBeLessThan(modal.bottom)
  expect(actions.getBoundingClientRect().bottom).toBeLessThanOrEqual(modal.bottom)
  const body = content.closest<HTMLElement>('.gg-as-body')!
  const bodyContentBottom = body.getBoundingClientRect().bottom - parseFloat(getComputedStyle(body).paddingBottom)
  expect(save.bottom).toBeCloseTo(bodyContentBottom, 0)
  expect(actions.querySelectorAll('button')).toHaveLength(1)
  expect(actions.querySelector('.gg-as-profile-danger')).toBeNull()
  expect(actions.querySelector('[role="switch"]')).toBeNull()
  expect(pause.disabled).toBe(false)
  expect(pause.dataset.slot).toBe('switch')
  expect(getComputedStyle(pause).opacity).toBe('1')
  const before = actions.getBoundingClientRect().toJSON()
  content.scrollTop = content.scrollHeight
  if (height === 620) expect(content.scrollTop).toBeGreaterThan(0)
  expect(actions.getBoundingClientRect().toJSON()).toEqual(before)
  const pauseBox = pauseRow.getBoundingClientRect()
  const removeBox = remove.getBoundingClientRect()
  expect(removeBox.top - pauseBox.bottom).toBeCloseTo(16, 0)
  expect(removeBox.left).toBeCloseTo(pauseBox.left, 0)
  expect(removeBox.width).toBeCloseTo(pauseBox.width, 0)
  expect(removeBox.bottom).toBeLessThanOrEqual(content.getBoundingClientRect().bottom)
  const bio = content.querySelector('textarea')!.getBoundingClientRect()
  expect(bio.height).toBe(84)
})
