// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSharePane } from '../../../../apps/desktop/src/components/agentsettings/AgentSharePane'
import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
import { clickElement, contact, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => { h.cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const agent = contact({ id: 'a1', type: 'agent', owner_user_id: 'u1' })
const render = () => renderWithAppProviders(h, <AgentSharePane agent={agent} />, { auth: { id: 'u1' } })

it('omits external sharing when the public URL is not configured and keeps forwarding', async () => {
  vi.stubEnv('VITE_GUGU_WEB_URL', '')
  await render()
  expect(h.container.textContent).toContain('转发给联系人')
  expect(h.container.textContent).not.toContain('对外分享')
  expect(h.container.querySelector('input[type="search"]')).not.toBeNull()
})

it('retains working external links, copy and publishing without a fee promise', async () => {
  vi.stubEnv('VITE_GUGU_WEB_URL', 'https://share.example.test')
  const publish = vi.spyOn(contactsService, 'setAgentPublic').mockResolvedValue({ ...agent, agent_public: true })
  const copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
  await render()
  await clickElement([...h.container.querySelectorAll('button')].find(button => button.textContent === '对外分享')!)
  expect(h.container.textContent).not.toMatch(/费用|手续费|赠送|即将/)
  expect(h.container.querySelector('[data-testid="agent-share-link"]')?.textContent).toBe('https://share.example.test/join/agent/a1')
  await clickElement(h.container.querySelector('[data-testid="agent-share-link"] + button')!)
  expect(copy).toHaveBeenCalledWith('https://share.example.test/join/agent/a1')
  await clickElement([...h.container.querySelectorAll('button')].find(button => button.textContent === '开启对外分享')!)
  expect(publish).toHaveBeenCalledWith('a1', true)
})
