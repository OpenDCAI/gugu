import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { AgentProfilePane } from '@/components/agentsettings/AgentProfilePane'
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { i18n } from '@/i18n'
import '@/i18n/registerAgentsCatalog'
import '@/styles/tokens.css'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())
for (const mobile of [false, true]) it(`aligns the pause row with the form and separates the next field (mobile=${mobile})`, async () => {
  await page.viewport(mobile ? 390 : 1100, mobile ? 844 : 800)
  await i18n.changeLanguage('zh-CN')
  h.container.style.cssText = 'max-width:650px;padding:24px'
  await renderWithAppProviders(h, <AgentProfilePane agent={contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })} />, { auth: { id: 'u1' } })
  const pause = h.container.querySelector('[data-testid="agent-profile-pause"]')!.getBoundingClientRect()
  const label = h.container.querySelector('.gg-settings-row-title')!.getBoundingClientRect()
  const nextField = h.container.querySelector('.gg-as-profile-row')!.getBoundingClientRect()
  expect(label.left).toBe(nextField.left)
  expect(nextField.top - pause.bottom).toBe(16)
  expect(h.container.querySelector('.gg-settings-row-description')!.textContent).toBe('暂停后只回应你和它的私聊。')
})
