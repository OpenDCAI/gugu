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
for (const mobile of [false, true]) it(`keeps profile actions visible while the fields scroll (mobile=${mobile})`, async () => {
  await page.viewport(mobile ? 390 : 1100, mobile ? 620 : 800)
  await i18n.changeLanguage('zh-CN')
  await renderWithAppProviders(h, <AgentSettingsModal agent={contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })} />, { auth: { id: 'u1' } })
  if (mobile) await page.getByRole('button', { name: '资料', exact: true }).click()
  const modal = document.querySelector('[data-testid="agent-settings-modal"]')!.getBoundingClientRect()
  const actions = document.querySelector<HTMLElement>('[data-testid="agent-profile-actions"]')!
  const content = document.querySelector<HTMLElement>('[data-testid="agent-profile-content"]')!
  const save = document.querySelector('.gg-as-profile-save')!.getBoundingClientRect()
  const pause = actions.querySelector<HTMLButtonElement>('[role="switch"]')!
  expect(save.bottom).toBeLessThan(modal.bottom)
  expect(actions.getBoundingClientRect().bottom).toBeLessThanOrEqual(modal.bottom)
  expect(actions.querySelector('.gg-as-profile-danger')).not.toBeNull()
  expect(pause.disabled).toBe(false)
  expect(pause.dataset.slot).toBe('switch')
  expect(getComputedStyle(pause).opacity).toBe('1')
  expect(content.scrollHeight).toBeGreaterThan(content.clientHeight)
  const before = actions.getBoundingClientRect().toJSON()
  content.scrollTop = content.scrollHeight
  expect(content.scrollTop).toBeGreaterThan(0)
  expect(actions.getBoundingClientRect().toJSON()).toEqual(before)
})
