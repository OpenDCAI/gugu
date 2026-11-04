import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store'
import { until } from '../../../../../../../tests/support/awaitCondition'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import '@/styles/tokens.css'
import '@renderer/index.css'

const active = vi.hoisted(() => ({ store: null as unknown, provider: '', source: null as unknown, agents: [] as AgentPayload[] }))
vi.mock('@renderer/features/tabs/pane-context', () => ({
  PaneContext: React.createContext(null),
  PaneProvider: ({ children }: { children: React.ReactNode }) => children,
  usePaneContext: () => ({ pane: { resolvedTabs: [{ isActive: true, kind: 'acp-chat', resource: { store: active.store } }] } }),
}))
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => active.source, allSessions: () => new Map() } }))
vi.mock('@renderer/lib/chat/use-session-chat-layout', () => ({ useSessionChatLayout: () => ({ preset: 'single', userGutter: 0 }) }))
vi.mock('@renderer/features/integrations/use-connected-issue-providers', () => ({ useConnectedIssueProviders: () => ({ connectedProviders: [], isProviderUsable: () => false }) }))
vi.mock('@renderer/features/library/prompts/use-prompt-library', () => ({ usePromptLibrary: () => ({ value: [] }) }))
vi.mock('@renderer/lib/stores/use-agents', () => ({
  AGENTS_METADATA_QUERY_KEY: ['agents', 'metadata'],
  useAgents: () => ({ data: active.agents }), useAgent: () => ({ data: undefined }), useAgentIcon: () => undefined,
}))

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: { invoke: async () => [], eventOn: () => () => {}, eventSend: () => {}, getPathForFile: () => '' },
})
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store')
const { AcpChatPanel } = await import('@renderer/features/sessions/acp/acp-chat-panel')
let root: Root | null = null
let host: HTMLDivElement | null = null
let store: InstanceType<typeof AcpChatStore> | null = null
let client: QueryClient | null = null

afterEach(() => {
  root?.unmount()
  host?.remove()
  store?.dispose()
  client?.clear()
  root = null
  host = null
  store = null
  active.store = null
  active.provider = ''
  active.agents = []
  active.source = null
})


function harness(id: string): AgentPayload {
  return { id, name: id, status: 'available', reading: 'installed', command: id, capabilities: {
    acp: { kind: 'supported' }, autoApprove: { kind: 'none' }, models: { kind: 'none' }, effort: { kind: 'none' },
    sessionpage: { acp: { identity: 'addressable', messageTransport: 'router' } },
    auth: { kind: 'supported', connections: { kind: 'managed' }, methods: [{ kind: 'cli-login', id: `${id}-login`, name: id, args: ['login'] }] },
  } } as unknown as AgentPayload
}

vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    refreshAuthStatus: async () => ({ success: true, data: { kind: 'unauthenticated' } }),
    listConnections: async () => ({ success: true, data: [{ id: 'native', kind: 'native', name: 'CLI', current: true }] }),
    readSubscription: async () => ({ success: true, data: { payer: 'not-signed-in' } }),
  }),
}))

it.each(['claude', 'codex'])('the real %s session sign-in action opens connections and returns to the same unsent draft', async provider => {
  registerSessionLocaleResources()
  setLocalePreference('en-US')
  await page.viewport(1100, 740)
  const id = `connection-${provider}`
  active.provider = provider
  active.agents = [harness(provider)]
  active.source = { sessions: new Map([[id, { status: 'idle', markSeen: async () => {}, data: { id, providerId: provider, firstUtterance: 'Original task', platformModel: null } }]]) }
  store = new AcpChatStore(id, 'project')
  active.store = store
  const current = store
  const submit = vi.spyOn(current, 'submitPrompt').mockResolvedValue()
  current.chatState.transcript.history.seed([{
    id: 'old-turn', seq: 0, initiator: 'user',
    items: [{ kind: 'message', id: 'old-user', seq: 0, role: 'user', text: 'Original task' }],
  }])
  const internals = current as unknown as { _bootstrapped: boolean }
  runInAction(() => {
    internals._bootstrapped = true
    current.historyLoading = false
    current.messageCount = 1
    current.loadError = { kind: 'auth_required', message: 'Configure the provider connection' }
    current.setDraftText('Unsent session draft')
  })
  host = document.createElement('div')
  host.className = 'emlight gugu-skin'
  host.style.height = '700px'
  document.body.append(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const errors: unknown[] = []
  root = createRoot(host, { onUncaughtError: error => errors.push(error) })
  root.render(<LocalizationProvider><QueryClientProvider client={client}><MessageProvider locale="en-US" translate={translateSessionMessage}><AcpChatPanel /></MessageProvider></QueryClientProvider></LocalizationProvider>)
  const href = location.href
  const signIn = page.getByRole('button', { name: translateSessionMessage('transcript.condition.signIn'), exact: true })
  await until('session sign-in is visible or its real tree failed', () => errors.length > 0 || signIn.query() !== null)
  expect(errors).toEqual([])
  await userEvent.click(signIn)
  await expect.element(page.getByRole('menuitem', { name: 'Add connection', exact: true })).toBeVisible()
  await userEvent.click(page.getByRole('menuitem', { name: 'Add connection', exact: true }))
  await expect.element(page.getByRole('dialog', { name: `Add a ${provider} connection`, exact: true })).toBeVisible()
  await userEvent.click(page.getByRole('button', { name: 'Close', exact: true }))
  await until('the connection form has closed', () => document.querySelector('.subscription-connection-form') === null)
  expect(current.sessionId).toBe(id)
  expect(active.store).toBe(current)
  expect(current.draftText).toBe('Unsent session draft')
  expect(host.textContent).toContain('Original task')
  expect(location.href).toBe(href)
  expect(submit).not.toHaveBeenCalled()
})
