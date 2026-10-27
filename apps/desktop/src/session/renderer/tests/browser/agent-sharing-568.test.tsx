import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { AgentSharePane } from '@/components/agentsettings/AgentSharePane'
import { contactsService } from '@/lib/contacts'
import { contact, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/i18n/registerAgentsCatalog'
import '@/styles/tokens.css'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => { h.cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
for (const mobile of [false, true]) it(`omits a one-option switcher and only exposes public links after enabling (mobile=${mobile})`, async () => {
  await page.viewport(mobile ? 390 : 1100, mobile ? 844 : 800)
  await i18n.changeLanguage('zh-CN')
  const agent = contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })
  vi.stubEnv('VITE_GUGU_WEB_URL', '')
  h.container.style.cssText = 'padding:24px;max-width:720px;margin:auto'
  await renderWithAppProviders(h, <AgentSharePane agent={agent} />, { auth: { id: 'u1' } })
  expect(h.container.querySelector('.gg-as-share-act-seg')).toBeNull()
  expect(h.container.querySelector('input')!.getBoundingClientRect().left).toBe(h.container.querySelector('.gg-as-share-act-empty')!.getBoundingClientRect().left)
  vi.stubEnv('VITE_GUGU_WEB_URL', 'https://public.example.test')
  const enable = vi.spyOn(contactsService, 'setAgentPublic').mockResolvedValue({ ...agent, agent_public: true })
  await renderWithAppProviders(h, <AgentSharePane agent={agent} />, { auth: { id: 'u1' } })
  await page.getByRole('button', { name: '对外分享', exact: true }).click()
  expect(h.container.querySelector('[data-testid="agent-share-link"]')).toBeNull()
  expect(h.container.querySelector('.gg-as-share-act-ext')!.querySelectorAll('button')).toHaveLength(1)
  await page.getByRole('button', { name: '开启对外分享', exact: true }).click()
  await until('published link is shown', () => !!h.container.querySelector('[data-testid="agent-share-link"]'))
  expect(enable).toHaveBeenCalledWith('a1', true)
  const copy = h.container.querySelector('[data-testid="agent-share-link"] + button')!
  expect(getComputedStyle(copy).backgroundColor).toBe('rgba(0, 0, 0, 0)')
})
