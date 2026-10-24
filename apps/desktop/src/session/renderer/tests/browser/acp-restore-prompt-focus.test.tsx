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

const active = vi.hoisted(() => ({ store: null as unknown }))
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
