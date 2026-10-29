// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const f = vi.hoisted(() => ({
  setup: vi.fn<(draft: unknown, device: string, options: { signal?: AbortSignal; onInstalling?: () => void }) => Promise<unknown>>(),
  pending: vi.fn(), resume: vi.fn(),
  SetupError: class extends Error {
    constructor(readonly kind: string, message: string) { super(message) }
  },
}))
vi.mock('react-i18next', async importOriginal => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/components/agentAvatar/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('@/components/ui/Button', () => ({ Button: ({ children, onClick, disabled, 'data-testid': testId }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; 'data-testid'?: string
}) => createElement('button', { onClick, disabled, 'data-testid': testId }, children) }))
vi.mock('@/components/assistant/AssistantSetupIdentity', () => ({ AssistantSetupIdentity: ({ onContinue }: { onContinue: () => void }) => createElement('button', { onClick: onContinue }, 'continue') }))
vi.mock('@/components/assistant/AssistantIntro', () => ({ AssistantIntro: () => null }))
vi.mock('@/components/settings/CloudComputerSection', () => ({ CloudComputerProvisionPanel: () => null, CloudComputerRefusal: () => null }))
vi.mock('@/lib/assistantSetup', () => ({ setUpAssistantOnThisComputer: f.setup, pendingLocalAssistant: f.pending, resumeLocalAssistant: f.resume,
  AssistantSetupError: f.SetupError, draftAvatarUrl: () => '', claimCloudAssistant: vi.fn() }))
vi.mock('@/lib/firstRun', () => ({ takeAssistantStartAtHome: () => true, readOccupation: async () => null }))
vi.mock('@/lib/assistantSetupState', () => ({ offerCustomizeCard: vi.fn(), writeSetupStep: vi.fn() }))
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: vi.fn() }))
vi.mock('@/lib/cloudComputerStore', () => ({ refreshCloudComputer: vi.fn() }))
vi.mock('@/lib/billing/membership', () => ({ getMembership: vi.fn() }))
vi.mock('@gugu/core/cloud/optionalServices', () => ({ cloudComputerEnabled: () => false }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { AssistantOnboarding } = await import('@/components/assistant/AssistantOnboarding')
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.clearAllMocks()
  f.setup.mockReset(); f.resume.mockReset()
  f.pending.mockReturnValue(null)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const click = async (element: Element | null) => { expect(element).not.toBeNull(); await act(async () => (element as HTMLElement).click()) }
async function render() {
  await act(async () => root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AssistantOnboarding, {
    ownerUserId: 'owner', ownerName: 'Owner', snapshot: null, device: null, cloudAvailable: false, localDeviceId: 'local',
  }))))
}

it('restores Back for a fresh preparation after a previous installation failed', async () => {
  f.setup.mockImplementationOnce(async (_draft, _device, options) => { options.onInstalling?.(); throw new Error('Write failed') })
  f.setup.mockImplementationOnce((_draft, _device, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  }))
  await render()
  await click(container.querySelector('button'))
  await click(container.querySelector('[data-testid="assistant-setup-install-here"]'))
  expect(container.querySelector('[data-testid="assistant-setup-return"]')).toBeNull()
  await click([...container.querySelectorAll('button')].find(button => button.textContent === 'setup.retry') ?? null)
  await click(container.querySelector('[data-testid="assistant-setup-return"]'))
  expect(container.querySelector('[data-testid="assistant-setup-install-here"]')).not.toBeNull()
})

it('keeps Back unavailable while resuming an already committed installation', async () => {
  f.pending.mockReturnValue({ operationId: 'existing' })
  f.resume.mockImplementationOnce(() => new Promise(() => {}))
  await render()
  expect(f.resume).toHaveBeenCalledOnce()
  expect(container.querySelector('[data-testid="assistant-setup-return"]')).toBeNull()
})

it('offers a new setup only after recovery confirms the old operation ended', async () => {
  f.pending.mockReturnValue({ operationId: 'old' })
  f.resume.mockImplementationOnce(async () => {
    f.pending.mockReturnValue(null)
    throw new f.SetupError('cancelled', 'old operation is terminal')
  })
  f.setup.mockResolvedValueOnce({ agentUserId: 'new' })
  await render()
  expect(f.setup).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('setup.ended')
  await click([...container.querySelectorAll('button')].find(button => button.textContent === 'setup.startNew') ?? null)
  expect(f.setup).toHaveBeenCalledOnce()
  expect(f.resume).toHaveBeenCalledOnce()
})

it('keeps retrying the same recovery when cancellation has not reached its terminal', async () => {
  const pending = { operationId: 'old' }
  f.pending.mockReturnValue(pending)
  f.resume.mockRejectedValue(new Error('cleanup still in progress'))
  await render()
  expect(container.textContent).not.toContain('setup.startNew')
  await click([...container.querySelectorAll('button')].find(button => button.textContent === 'setup.retry') ?? null)
  expect(f.resume.mock.calls).toEqual([[pending], [pending]])
  expect(f.setup).not.toHaveBeenCalled()
})
