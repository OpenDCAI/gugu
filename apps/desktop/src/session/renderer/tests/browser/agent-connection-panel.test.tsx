import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'
import { ComposerModelMenu } from '@gugu/session-ui/react/components'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal'
import { useConnectionPanel } from '@renderer/features/settings/subscriptions/use-connection-panel'
import { subscriptionKey } from '@renderer/features/settings/subscriptions/subscription-queries'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { setLocalePreference } from '@/i18n'
import { modalStore } from '@renderer/lib/modal/modal-store'
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer'
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

const control = vi.hoisted(() => ({
  state: 'unauthenticated',
  hold: null as Promise<void> | null,
  connections: [] as HarnessConnection[],
  created: null as Record<string, unknown> | null,
  selected: '',
  rejectSelect: false,
  busy: false
}))

function agent(id: string): AgentPayload {
  return {
    id,
    name: id === 'codex' ? 'Codex' : 'Claude',
    status: 'available',
    reading: 'installed',
    command: id,
    installOptions: [],
    capabilities: {
      hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } },
      hooks: { kind: 'none' },
      sessions: { kind: 'stateless' },
      auth: {
        kind: 'supported',
        methods: [{ kind: 'cli-login', id: `${id}-login`, name: id, args: ['login'] }]
      }
    }
  } as unknown as AgentPayload
}

// Only the host boundary answers fixtures. The detail, menu, nested form and all
// Base UI portals are real components, with the product styles and localization.
vi.mock('@renderer/lib/ipc', async (original) => {
  const actual = await original<typeof import('@renderer/lib/ipc')>()
  const pending = () => new Promise(() => {})
  const agents = {
    getManagement: async (id: string) => agent(id),
    list: async () => [agent('claude'), agent('codex')],
    listIcons: async () => ({}),
    listAgentInstallationStatus: async () => [],
    getSettings: async () => null,
    modelCatalog: async () => ({ state: { kind: 'ready', models: [] }, refreshing: false })
  }
  return {
    ...actual,
    rpcOn: () => ({ agents }),
    onMachineEvent: () => () => {},
    events: { on: () => () => {} },
    rpc: new Proxy(
      {},
      { get: (_, key) => (key === 'agents' ? agents : new Proxy({}, { get: () => pending })) }
    )
  }
})

vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    refreshAuthStatus: async ({ connectionId }: { connectionId?: string }) => {
      if (!connectionId && control.hold) await control.hold
      return { success: true, data: { kind: control.state } }
    },
    listConnections: async () => ({ success: true, data: [...control.connections] }),
    readSubscription: async () => ({ success: true, data: { payer: 'not-signed-in' } }),
    readSubscriptionUsage: async () => ({
      success: true,
      data: { kind: 'unavailable', reason: 'not-signed-in' }
    }),
    createConnection: async (input: Record<string, unknown>) => {
      control.created = input
      const created: HarnessConnection = {
        id: 'api',
        kind: 'api-key',
        name: 'Saved API',
        current: false
      }
      control.connections.push(created)
      return { success: true, data: created }
    },
    selectConnection: async ({ connectionId }: { connectionId: string }) => {
      if (control.rejectSelect) {
        control.selected = 'rejected'
        return {
          success: false,
          error: {
            type: 'invalid-state',
            message: 'Connection could not switch',
            ...(control.busy ? { sessionsBusy: { providerId: 'codex', count: 2 } } : {})
          }
        }
      }
      control.selected = connectionId
      control.state = 'authenticated'
      control.connections = control.connections.map((c) => ({
        ...c,
        current: c.id === connectionId
      }))
      return { success: true }
    }
  })
}))

vi.mock('@renderer/lib/acp/auth-login-binding', () => ({
  AcpAuthLoginBinding: {
    create: async () => ({
      sendInput: () => {},
      resize: () => {},
      markUrlHandled: () => {},
      dispose: () => {},
      status: { current: () => ({ status: { kind: 'unauthenticated' }, login: null }) }
    })
  }
}))

let root: Root
let host: HTMLDivElement
let client: QueryClient
beforeEach(() => {
  setLocalePreference('en-US')
  control.state = 'unauthenticated'
  control.hold = null
  control.created = null
  control.selected = ''
  control.rejectSelect = false
  control.busy = false
  control.connections = [{ id: 'native', kind: 'native', name: 'CLI', current: true }]
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  modalStore.closeModal()
  root.unmount()
  client.clear()
  host.remove()
})

function render(node: React.ReactNode) {
  root.render(
    <QueryClientProvider client={client}>
      <SessionLocalizationProvider>{node}</SessionLocalizationProvider>
    </QueryClientProvider>
  )
}

const box = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect()
  return { x, y, width, height }
}

it.each([1440, 390])(
  'connection fields remain accessible above the detail at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    render(<AgentDetailModal agentId="codex" onClose={vi.fn()} />)
    await userEvent.click(page.getByRole('button', { name: 'Add', exact: true }))
    const dialog = page.getByRole('dialog', { name: 'Codex', exact: true })
    await expect.element(dialog).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Account sign-in', exact: true }))
      .toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }))
    await expect.element(page.getByLabelText('API Key', { exact: true })).toBeVisible()
    await userEvent.click(
      page.getByRole('checkbox', { name: 'Use a third-party API', exact: true })
    )
    await expect
      .element(page.getByRole('textbox', { name: 'API address', exact: true }))
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Save connection', exact: true }))
      .toBeVisible()
    const form = document.querySelector('.subscription-connection-form')!
    expect(form.closest('[aria-hidden="true"], [inert]')).toBeNull()
    expect(form.closest('[role="dialog"]')?.parentElement?.closest('[role="dialog"]')).toBeNull()
  }
)

it.each([1440, 390])(
  'detail keeps cached connection controls during background checks at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    for (const id of ['codex', 'claude']) {
      render(<AgentDetailModal key={id} agentId={id} onClose={vi.fn()} />)
      const detail = page.getByRole('dialog', {
        name: id === 'codex' ? 'Codex' : 'Claude',
        exact: true
      })
      const connection = detail.getByRole('combobox', { name: 'Current connection', exact: true })
      await expect.element(connection).toBeEnabled()
      await until(
        'initial authentication result settles',
        () =>
          client.getQueryState([...subscriptionKey(null, id), 'availability'])?.fetchStatus ===
          'idle'
      )
      for (const advanced of [false, true]) {
        if (advanced)
          await userEvent.click(page.getByRole('button', { name: 'Advanced', exact: true }))
        await untilStable('detail animation settled', () => box(detail.element()))
        const initial = box(detail.element())
        const connectionBox = box(connection.element())
        let finish!: () => void
        control.hold = new Promise<void>((resolve) => {
          finish = resolve
        })
        const pending = client.invalidateQueries({
          queryKey: [...subscriptionKey(null, id), 'availability']
        })
        await until(
          'background authentication check starts',
          () =>
            client.getQueryState([...subscriptionKey(null, id), 'availability'])?.fetchStatus ===
            'fetching'
        )
        await expect.element(connection).toBeEnabled()
        expect(connection.element().textContent).toContain('Existing CLI configuration')
        expect(box(detail.element())).toEqual(initial)
        expect(box(connection.element())).toEqual(connectionBox)
        finish()
        await pending
        control.hold = null
        for (const state of ['authenticated', 'unknown', 'unauthenticated']) {
          control.state = state
          await client.invalidateQueries({
            queryKey: [...subscriptionKey(null, id), 'availability']
          })
          await untilStable('credential state layout settled', () => box(detail.element()))
          expect(box(detail.element())).toEqual(initial)
          expect(box(connection.element())).toEqual(connectionBox)
          await expect.element(connection).toBeEnabled()
        }
      }
    }
  }
)

function TaskDraft() {
  const [prompt, setPrompt] = useState('Original draft')
  const panel = useConnectionPanel()
  return (
    <>
      <input aria-label="Task draft" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      <ComposerModelMenu
        panel={{ kind: 'shown', modelRow: 'list' }}
        modelItems={[]}
        effortItems={[]}
        modelUnlock={{ groupLabel: 'Your Codex models', label: 'Go sign in' }}
        onModelUnlock={(anchor) => panel.show(agent('codex'), null, anchor)}
      />
      {panel.panel}
    </>
  )
}

it('a task overlays the same connection form and returns to its draft after API selection', async () => {
  render(<TaskDraft />)
  const href = location.href
  await userEvent.fill(page.getByRole('textbox', { name: 'Task draft' }), 'Keep this draft')
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await userEvent.click(page.getByRole('menuitem', { name: 'Add connection', exact: true }))
  await userEvent.click(page.getByRole('button', { name: 'API Key', exact: true }))
  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'fixture-key')
  await userEvent.click(page.getByRole('button', { name: 'Save connection', exact: true }))
  await until(
    'saved API is selectable',
    () => !!document.querySelector('[data-testid="connection-use-api"]')
  )
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until('the selected connection is committed', () => control.selected === 'api')
  await expect
    .element(page.getByRole('textbox', { name: 'Task draft' }))
    .toHaveValue('Keep this draft')
  expect(location.href).toBe(href)
  expect(control.created).toMatchObject({ providerId: 'codex', apiKey: 'fixture-key' })
})

it('a rejected task connection remains visible with its cause and keeps the original draft and connection', async () => {
  control.rejectSelect = true
  control.connections.push({ id: 'api', kind: 'api-key', name: 'Saved API', current: false })
  render(<TaskDraft />)
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until('the host refused the switch', () => control.selected === 'rejected')
  await until(
    'the refusal is shown',
    () =>
      document
        .querySelector('.subscription-connection-menu [role="alert"]')
        ?.textContent?.includes('Connection could not switch') === true
  )
  // The refusal stays where it was asked: the menu is still open, not exit-animating with the notice inside it.
  expect(document.querySelector('.subscription-connection-menu')?.hasAttribute('data-open')).toBe(
    true
  )
  expect(control.connections.find((c) => c.current)?.id).toBe('native')
  expect((host.querySelector('input') as HTMLInputElement).value).toBe('Original draft')
})

it.each([1440, 1024, 800, 390])(
  'an unsigned saved account keeps its real login action while native does not offer one at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    control.connections.push({
      id: 'saved-account',
      kind: 'account',
      name: 'Saved account',
      current: false
    })
    render(<AgentDetailModal agentId="codex" onClose={vi.fn()} />)
    const detail = page.getByRole('dialog', { name: 'Codex', exact: true })
    const configure = detail.getByRole('combobox', { name: 'Current connection', exact: true })
    await expect.element(configure).toBeVisible()
    await untilStable('the complete detail content settles', () => box(detail.element()))
    const bounds = detail.element().getBoundingClientRect()
    const buttonBounds = configure.element().getBoundingClientRect()
    expect(buttonBounds.top).toBeGreaterThanOrEqual(bounds.top)
    expect(buttonBounds.bottom).toBeLessThanOrEqual(bounds.bottom)
    await userEvent.click(page.getByRole('combobox', { name: 'Current connection', exact: true }))
    await until(
      'native status is read',
      () => !!document.querySelector('[data-testid="connection-native"]')
    )
    expect(
      document.querySelector('[data-testid="connection-native"] [aria-haspopup="menu"]')
    ).toBeNull()
    await userEvent.click(
      page.getByRole('button', { name: 'Options for Saved account', exact: true })
    )
    const signIn = page.getByRole('menuitem', { name: 'Sign in', exact: true })
    await expect.element(signIn).toBeVisible()
    const item = signIn.element()
    await untilStable('the sign-in item settles', () => box(item))
    const rect = item.getBoundingClientRect()
    expect(
      item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    ).toBe(true)
    await userEvent.click(page.getByRole('menuitem', { name: 'Sign in', exact: true }))
    expect(modalStore.activeModalId).toBe('agentSignInModal')
    expect(modalStore.activeModalArgs).toMatchObject({
      providerId: 'codex',
      connectionId: 'saved-account',
      steps: [{ methodId: 'codex-login' }]
    })
    expect(modalStore.activeModalArgs).not.toHaveProperty('portalContainer')
  }
)

it('working sessions refuse a task connection switch with a calm status and keep the native connection', async () => {
  control.rejectSelect = true
  control.busy = true
  control.connections.push({ id: 'api', kind: 'api-key', name: 'Saved API', current: false })
  render(<TaskDraft />)
  await userEvent.click(page.getByTestId('composer-model-trigger'))
  await userEvent.click(page.getByRole('button', { name: 'Go sign in', exact: true }))
  await userEvent.click(page.getByTestId('connection-use-api'))
  await until(
    'the busy refusal is rendered',
    () =>
      document
        .querySelector('.subscription-connection-menu [role="status"]')
        ?.textContent?.includes('2 Codex sessions') === true
  )
  expect(document.querySelector('.subscription-connection-menu')?.hasAttribute('data-open')).toBe(
    true
  )
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(document.querySelector('[role="status"]')?.classList.contains('subscription-error')).toBe(
    false
  )
  expect(control.connections.find((c) => c.current)?.id).toBe('native')
})

it.each([800, 1440])(
  'the real global sign-in terminal remains accessible and clickable above the detail at %ipx',
  async (width) => {
    await page.viewport(width, 900)
    control.connections.push({
      id: 'saved-account',
      kind: 'account',
      name: 'Saved account',
      current: false
    })
    render(
      <>
        <AgentDetailModal agentId="codex" onClose={vi.fn()} />
        <ModalRenderer />
      </>
    )
    await userEvent.click(page.getByRole('combobox', { name: 'Current connection', exact: true }))
    await userEvent.click(
      page.getByRole('button', { name: 'Options for Saved account', exact: true })
    )
    await userEvent.click(page.getByRole('menuitem', { name: 'Sign in', exact: true }))
    const login = page.getByRole('dialog', { name: 'Sign in to Codex', exact: true })
    await expect.element(login).toBeVisible()
    const dialog = login.element()
    expect(dialog.closest('[aria-hidden="true"], [inert]')).toBeNull()
    const cancel = login.getByRole('button', { name: 'Cancel sign-in', exact: true })
    await untilStable('the actual sign-in footer settles', () => box(cancel.element()))
    const rect = cancel.element().getBoundingClientRect()
    expect(
      document
        .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        ?.closest('button')
    ).toBe(cancel.element())
    await userEvent.click(cancel)
    await until('the real login has closed', () => !modalStore.isOpen)
    await expect.element(page.getByRole('dialog', { name: 'Codex', exact: true })).toBeVisible()
  }
)
