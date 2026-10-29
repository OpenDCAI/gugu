import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

const active = vi.hoisted(() => ({
  store: null as unknown,
  record: null as import('@shared/core/sessions/sessions').Session | null,
  pageStore: null as import('@renderer/features/sessions/page-sessions-store').PageSessionsStore | null,
  engineDraft: null as { text: string; rev: number; updatedAt: number } | null,
  toasts: [] as Array<{ title: string; description?: string }>,
  restart: vi.fn(), start: vi.fn(), draft: vi.fn(),
}))
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: (id: string) => active.record?.id === id ? active.pageStore : undefined },
}))
vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: (value: { title: string; description?: string }) => active.toasts.push(value),
}))
// The panel and retry/store logic are real; only the host runtime/replication
// boundary is controlled, as in the store's resume-failure tests.
vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({
    startSession: active.start, setPromptDraft: active.draft,
    session: { state: (_key: unknown, topic: string) => ({ topic }) },
    getHistory: async () => ({ success: true, data: {
      turns: [], nextCursor: null, cursor: { epoch: 'provider', seq: 0 }, reset: false, count: 0,
    } }),
  }),
}))
vi.mock('@gugu/session-wire', async original => ({
  ...(await original<typeof import('@gugu/session-wire')>()),
  ReplicaState: class {
    readonly ready = Promise.resolve()
    constructor(private handle: { topic: string }) {}
    current() {
      switch (this.handle.topic) {
        case 'state': return { lifecycle: 'ready', isGenerating: false, queuedPrompts: [], pendingPermissions: [], canSubmit: true }
        case 'agents': case 'terminals': return []
        case 'config': return {}
        case 'draft': return active.engineDraft
        default: return null
      }
    }
    onChange() { return () => {} }
    onGone() { return () => {} }
    async dispose() {}
  },
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
  value: { invoke: async (channel: string, ...args: unknown[]) => {
    if (channel === 'sessions.restartSession') return active.restart(...args)
    if (channel === 'sessions.getStoredHistory') {
      const request = args[0] as { fromSeq?: number } | undefined
      return { turns: [{ id: 'saved-turn', seq: 0, initiator: 'user', items: [{ kind: 'message', id: 'saved-prompt', seq: 0, role: 'user', text: 'Saved history remains readable' }] }].filter(turn => turn.seq >= (request?.fromSeq ?? 0)), originTurnIds: [], nextCursor: null }
    }
    return []
  }, eventOn: () => () => {}, eventSend: () => {}, getPathForFile: () => '' },
})
const { PageSessionsStore } = await import('@renderer/features/sessions/page-sessions-store')
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store')
const { AcpChatPanel } = await import('@renderer/features/sessions/acp/acp-chat-panel')
let root: Root | null = null
let host: HTMLDivElement | null = null
let store: InstanceType<typeof AcpChatStore> | null = null
let client: QueryClient | null = null

beforeEach(() => {
  active.start.mockReset().mockResolvedValue({ success: true, data: { providerSessionId: 'live-provider-id' } })
  active.toasts.length = 0
  active.engineDraft = null
  active.draft.mockReset().mockImplementation(async ({ draft }) => {
    active.engineDraft = draft.input ? { ...draft.input, rev: draft.rev, updatedAt: 1 } : null
    return { success: true, data: undefined }
  })
})

afterEach(() => {
  root?.unmount()
  host?.remove()
  store?.dispose()
  client?.clear()
  root = null
  host = null
  store = null
  active.store = null
  active.pageStore?.dispose()
  active.pageStore = null
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
  active.pageStore = new PageSessionsStore('project', current.sessionId, [{
    id: current.sessionId, projectId: 'project', providerId: 'codex', title: 'Saved task', lastInteractedAt: null,
    providerSessionId: 'saved-provider-id', providerSessionState: 'missing', firstUtterance,
  }])
  active.record = active.pageStore.sessions.get(current.sessionId)!.data
  const internals = current as unknown as { _bootstrapped: boolean; _startInput: () => unknown }
  internals._startInput = () => ({ sessionId: current.sessionId, providerId: 'codex', providerSessionId: active.record?.providerSessionId })
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

  it('Start fresh starts once from the confirmed RPC even when no reset event arrives', async () => {
    const reset = Promise.withResolvers<void>()
    active.restart.mockReturnValueOnce(reset.promise)
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    current.setDraftText('kept while resetting')
    await until('Start fresh is visible', () => conditionButton('startFresh').query()?.checkVisibility() === true)
    await conditionButton('startFresh').click()
    await conditionButton('startFresh').click()
    expect(active.restart.mock.calls).toEqual([['project', current.sessionId]])
    expect(active.start).not.toHaveBeenCalled()
    reset.resolve()
    await until('the real retry starts with the confirmed reset', () => current.session !== null)
    expect(active.start).toHaveBeenCalledExactlyOnceWith({ input: expect.objectContaining({ providerSessionId: undefined }) })
    expect(current.loadError).toBeNull()
    expect(current.draftText).toBe('kept while resetting')
    expect(active.engineDraft?.text).toBe('kept while resetting')
    expect(current.chatState.transcript.state.committedTurns.map(turn => turn.id)).toEqual(['saved-turn'])
  })

  it('Start fresh reports a refused host reset and leaves the actions usable', async () => {
    active.restart.mockRejectedValueOnce(new Error('host reset refused'))
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    await until('Start fresh is visible', () => conditionButton('startFresh').query()?.checkVisibility() === true)
    await conditionButton('startFresh').click()
    await until('the original reset error is visible', () => active.toasts.some(toast => toast.description?.includes('host reset refused')))
    expect(active.restart).toHaveBeenCalledTimes(1)
    expect(active.start).not.toHaveBeenCalled()
    expect(current.historyLoading).toBe(false)
    expect(current.providerSessionMissing).toBe(true)
  })

  it('does not start a disposed task after its pending reset returns', async () => {
    const reset = Promise.withResolvers<void>()
    active.restart.mockReturnValueOnce(reset.promise)
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    await until('Start fresh is visible', () => conditionButton('startFresh').query()?.checkVisibility() === true)
    await conditionButton('startFresh').click()
    root!.unmount(); root = null
    current.dispose()
    reset.resolve()
    await reset.promise
    await Promise.resolve(); await Promise.resolve()
    expect(active.start).not.toHaveBeenCalled()
  })

  it('keeps Retry but omits Start fresh when no first utterance was saved', async () => {
    await mountFailedTask('provider_session_missing')
    await until('missing Retry is visible', () => conditionButton('retry').query()?.checkVisibility() === true)
    expect(conditionButton('startFresh').query()).toBeNull()
  })

  it('Reconnect rebuilds the visible missing condition without probing the old ID', async () => {
    const current = await mountFailedTask('adapter_lost', 'original prompt')
    await until('Reconnect is visible', () => conditionButton('reconnect').query()?.checkVisibility() === true)
    await conditionButton('reconnect').click()
    await until('ordinary retry restores the missing condition', () => current.loadError?.kind === 'provider_session_missing' && current.historyLoading === false)
    await until('the missing Retry action is still visible', () => conditionButton('retry').query()?.checkVisibility() === true)
    expect(active.start).not.toHaveBeenCalled()
    expect(current.chatState.transcript.state.committedTurns.map(turn => turn.id)).toEqual(['saved-turn'])
    expect(active.restart).not.toHaveBeenCalled()
  })
})


describe('draft conflict actions', () => {
  it.each(['engine', 'local'] as const)('preserves both texts until the user chooses %s', async choice => {
    const current = await mountFailedTask('provider_session_missing', 'original prompt')
    current.setDraftText('local offline draft')
    active.engineDraft = { text: 'other device draft', rev: 1, updatedAt: 1 }
    await until('missing Retry is visible', () => conditionButton('retry').query()?.checkVisibility() === true)
    await conditionButton('retry').click()
    const conflict = page.getByTestId('draft-conflict')
    await until('the real conflict controls are visible', () => conflict.query()?.checkVisibility() === true)
    expect(current.draftText).toBe('local offline draft')
    expect(active.engineDraft.text).toBe('other device draft')
    expect(active.draft).not.toHaveBeenCalled()
    const key = choice === 'engine' ? 'composer.useEngineDraft' : 'composer.overwriteEngineDraft'
    await page.getByRole('button', { name: translateSessionMessage(key), exact: true }).click()
    const expected = choice === 'engine' ? 'other device draft' : 'local offline draft'
    await until('the explicit draft choice is applied', () => current.draftText === expected && active.engineDraft?.text === expected)
    expect(current.draftConflict).toBeNull()
    expect(conflict.query()).toBeNull()
    expect(active.draft).toHaveBeenCalledTimes(choice === 'engine' ? 0 : 1)
  })
})
