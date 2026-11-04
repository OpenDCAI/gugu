// @vitest-environment jsdom
import { createElement } from 'react'
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('@/components/agentAvatar/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('@/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn() }))
vi.mock('@/components/settings/CloudComputerSection', () => ({ CloudComputerRefusal: () => null }))
import { AssistantHomeChoice } from '../../../../apps/desktop/src/components/assistant/AssistantHomeChoice'

let harness: ReturnType<typeof createReactHarness>
const callbacks = { onCloud: vi.fn(), onServer: vi.fn(), onComputer: vi.fn(), onUpgrade: vi.fn(), onBack: vi.fn() }
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks() })
afterEach(() => harness.cleanup())
async function render(over: Record<string, unknown> = {}) {
  await harness.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AssistantHomeChoice, {
    name: '咕咕', member: true, cloudEnabled: true, cloudAvailable: true, canHostHere: true,
    busy: false, error: null, cloudFailure: null, draftAvatar: '', ...callbacks, ...over,
  })))
}
function query(id: string) { return harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`) }
async function click(id: string) { await act(async () => query(id)!.click()) }

it.each([true, false])('keeps cloud recommended and first for member=%s', async member => {
  await render({ member })
  expect([...harness.container.querySelectorAll('.ta-onb-choice')].map(row => row.getAttribute('data-testid'))).toEqual([
    'assistant-setup-home-cloud', 'assistant-setup-home-server', 'assistant-setup-home-computer',
  ])
  expect(query('assistant-setup-home-cloud')?.getAttribute('data-recommended')).toBe('true')
  await click(member ? 'assistant-setup-claim-cloud' : 'assistant-setup-member')
  expect(member ? callbacks.onCloud : callbacks.onUpgrade).toHaveBeenCalledOnce()
  expect(member ? callbacks.onUpgrade : callbacks.onCloud).not.toHaveBeenCalled()
})

it('shows the cloud membership requirement only to free accounts', async () => {
  await render({ member: false })
  expect(query('assistant-setup-home-cloud')?.textContent).toContain('Plus 及以上可用')

  await render({ member: true })
  expect(query('assistant-setup-home-cloud')?.textContent).not.toContain('Plus 及以上可用')
})

it('routes server and local choices to their own setup paths', async () => {
  await render()
  expect(query('assistant-setup-home-server')?.textContent).toContain('Linux')
  expect(query('assistant-setup-home-server')?.textContent).not.toContain('Mac')
  expect(query('assistant-setup-home-computer')?.textContent).toContain('电脑开着时才在线，适合先试试')
  await click('assistant-setup-choose-server')
  await click('assistant-setup-install-here')
  expect(callbacks.onServer).toHaveBeenCalledOnce()
  expect(callbacks.onComputer).toHaveBeenCalledOnce()
})

it('preserves cloud setup on mobile while hiding server and local installation', async () => {
  await render({ canHostHere: false })
  expect(query('assistant-setup-home-nocomputer')).not.toBeNull()
  expect(query('assistant-setup-claim-cloud')).not.toBeNull()
  expect(query('assistant-setup-choose-server')).toBeNull()
  expect(query('assistant-setup-install-here')).toBeNull()
  await click('assistant-setup-claim-cloud')
  expect(callbacks.onCloud).toHaveBeenCalledOnce()
})

it('does not present a disabled cloud service as a membership restriction', async () => {
  await render({ cloudAvailable: false, member: false })
  expect(query('assistant-setup-member')).toBeNull()
  expect(query('assistant-setup-home-cloud')?.getAttribute('data-recommended')).toBe('false')
  expect(query('assistant-setup-choose-server')).not.toBeNull()
})
