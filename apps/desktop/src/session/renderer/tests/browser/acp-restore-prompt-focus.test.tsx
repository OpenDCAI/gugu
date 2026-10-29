import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

const active = vi.hoisted(() => ({
  store: null as unknown,
  record: null as { id: string; providerId: string; providerSessionId: string; providerSessionState: 'missing'; firstUtterance?: string } | null,
  restart: vi.fn(),
}))
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: (id: string) => active.record?.id === id ? {
    sessions: new Map([[id, { data: active.record, seen: true }]]),
    restartSession: active.restart,
  } : undefined },
}))
vi.mock('@renderer/features/tabs/pane-context', () => ({
  PaneContext: React.createContext(null),
  PaneProvider: ({ children }: { children: React.ReactNode }) => children,
  usePaneContext: () => ({ pane: { resolvedTabs: [{ isActive: true, kind: 'acp-chat', resource: { store: active.store } }] } }),
}))
vi.mock('@renderer/lib/chat/use-session-chat-layout', () => ({ useSessionChatLayout: () => ({ preset: 'single', userGutter: 0 }) }))
vi.mock('@renderer/features/integrations/use-connected-issue-providers', () => ({ useConnectedIssueProviders: () => ({ connectedProviders: [], isProviderUsable: () => false }) }))
vi.mock('@renderer/features/library/prompts/use-prompt-library', () => ({ usePromptLibrary: () => ({ value: [] }) }))
vi.mock('@renderer/lib/stores/use-agents', () => ({
  AGENTS_METADATA_QUERY_KEY: ['agents', 'metadata'],
  useAgents: () => ({ data: [] }), useAgent: () => ({ data: undefined }), useAgentIcon: () => undefined,
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
  active.record = null
  active.restart.mockReset()
})

describe.each([1100, 390])('Restore prompt at viewport width %i', (width) => {
  it('restores the original prompt unsent, focuses its end, and lets Enter submit', async () => {
    registerSessionLocaleResources()
    setLocalePreference('en-US')
    await page.viewport(width, 740)
    const original = 'Review this file\nThen explain the result'
    store = new AcpChatStore('restore-focus', 'project')
    active.store = store
    const current = store
    const internals = current as unknown as { _bootstrapped: boolean }
    const submit = vi.spyOn(store, 'submitPrompt').mockImplementation(() => {})
    store.chatState.transcript.history.seed([{
      id: 'failed-turn', seq: 0, initiator: 'user',
      items: [{ kind: 'message', id: 'original-prompt', seq: 0, role: 'user', text: original }],
      outcome: { kind: 'error', reason: 'prompt_failed', detail: 'Test failure' },
    }])
    runInAction(() => {
      // A loaded, failed task may queue another prompt while its engine is detached.
      internals._bootstrapped = true
      current.historyLoading = false
      current.messageCount = 1
    })
    host = document.createElement('div')
    host.className = 'emlight gugu-skin'
    host.style.height = '700px'
    document.body.appendChild(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    root = createRoot(host)
    root.render(<LocalizationProvider><QueryClientProvider client={client}><MessageProvider locale="en-US" translate={translateSessionMessage}><AcpChatPanel /></MessageProvider></QueryClientProvider></LocalizationProvider>)

    const editor = page.getByTestId('prompt-editor')
    await until('the real composer is mounted', () => editor.query() !== null)
    const restore = page.getByRole('button', { name: translateSessionMessage('transcript.restorePromptHint'), exact: true })
    await until('the real Restore prompt button is visible', () => restore.query()?.checkVisibility() === true)
    await restore.click()
    await until('the original text is restored', () => store?.draftText === original && editor.element().textContent === original.replace(/\n/g, ''))
    expect(submit).not.toHaveBeenCalled()
    await until('restored editor receives focus', () => ({
      tag: document.activeElement?.tagName,
      label: document.activeElement?.getAttribute('aria-label'),
      focused: document.activeElement === editor.element(),
    }), (reading) => reading.focused)
    await restore.click()
    await until('restoring the same text also returns focus', () => document.activeElement === editor.element())
    await userEvent.keyboard(' appended')
    await until('typing appends to the restored text', () => store?.draftText === `${original} appended`)
    await userEvent.keyboard('{Enter}')
    await until('Enter submits the restored prompt', () => submit.mock.calls.length === 1)
    expect(submit.mock.calls[0]?.[0]).toBe(`${original} appended`)
  })
})


async function mountFailedTask(kind: 'provider_session_missing' | 'adapter_lost', firstUtterance?: string) {
  registerSessionLocaleResources()
  setLocalePreference('en-US')
  await page.viewport(1100, 740)
  const current = new AcpChatStore('condition-actions', 'project')
  store = current
  active.store = current
  active.record = { id: current.sessionId, providerId: 'codex', providerSessionId: 'saved-provider-id', providerSessionState: 'missing', firstUtterance }
  const internals = current as unknown as { _bootstrapped: boolean }
  runInAction(() => {
    internals._bootstrapped = true
    current.historyLoading = false
    current.loadError = { kind, message: 'The saved engine session is unavailable' }
    current.messageCount = 1
  })
  current.chatState.transcript.history.seed([{
    id: 'saved-turn', seq: 0, initiator: 'user',
    items: [{ kind: 'message', id: 'saved-prompt', seq: 0, role: 'user', text: 'Saved history remains readable' }],
  }])
  host = document.createElement('div')
  host.className = 'emlight gugu-skin'
  host.style.height = '700px'
  document.body.appendChild(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(host)
  root.render(<LocalizationProvider><QueryClientProvider client={client}><MessageProvider locale="en-US" translate={translateSessionMessage}><AcpChatPanel /></MessageProvider></QueryClientProvider></LocalizationProvider>)
  return current
}

const conditionButton = (key: 'retry' | 'startFresh' | 'reconnect') =>
  page.getByRole('button', { name: translateSessionMessage(`transcript.condition.${key}`), exact: true })

describe('missing-session condition actions', () => {
  it('only the missing Retry button explicitly requests a same-ID probe', async () => {
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    const retry = vi.spyOn(current, 'retry').mockImplementation(() => {})
    await until('missing Retry is visible', () => conditionButton('retry').query()?.checkVisibility() === true)
    await conditionButton('retry').click()
    expect(retry.mock.calls).toEqual([[{ retryMissing: true }]])
    expect(active.restart).not.toHaveBeenCalled()
  })

  it('Start fresh waits for the host reset and then uses the ordinary retry path', async () => {
    const reset = Promise.withResolvers<void>()
    active.restart.mockReturnValueOnce(reset.promise)
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    const retry = vi.spyOn(current, 'retry').mockImplementation(() => {})
    await until('Start fresh is visible', () => conditionButton('startFresh').query()?.checkVisibility() === true)
    await conditionButton('startFresh').click()
    expect(active.restart.mock.calls).toEqual([[current.sessionId]])
    expect(retry).not.toHaveBeenCalled()
    reset.resolve()
    await until('retry follows the successful host reset', () => retry.mock.calls.length === 1)
    expect(retry.mock.calls).toEqual([[]])
  })

  it('does not retry if Start fresh fails at the host boundary', async () => {
    active.restart.mockRejectedValueOnce(new Error('host reset refused'))
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    const retry = vi.spyOn(current, 'retry').mockImplementation(() => {})
    await until('Start fresh is visible', () => conditionButton('startFresh').query()?.checkVisibility() === true)
    await conditionButton('startFresh').click()
    expect(active.restart).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(retry).not.toHaveBeenCalled()
  })

  it('keeps Retry but omits Start fresh when no first utterance was saved', async () => {
    await mountFailedTask('provider_session_missing')
    await until('missing Retry is visible', () => conditionButton('retry').query()?.checkVisibility() === true)
    expect(conditionButton('startFresh').query()).toBeNull()
  })

  it('Reconnect leaves missing re-probing disabled', async () => {
    const current = await mountFailedTask('adapter_lost', 'original prompt')
    const retry = vi.spyOn(current, 'retry').mockImplementation(() => {})
    await until('Reconnect is visible', () => conditionButton('reconnect').query()?.checkVisibility() === true)
    await conditionButton('reconnect').click()
    expect(retry.mock.calls).toEqual([[]])
    expect(active.restart).not.toHaveBeenCalled()
  })
})
