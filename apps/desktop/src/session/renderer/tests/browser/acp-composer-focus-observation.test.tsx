import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { runInAction } from 'mobx'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store'
import { sessionNavigationFocus } from '@renderer/features/sidebar/session-navigation-focus'
import { PageShownContext } from '@renderer/app/recent-session-pages'
import { requestComposerEntryFocus } from '@/lib/composerEntryFocus'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

/**
 * A file open beside the chat, a file-tree row clicked (focus layer = nav), then the first click into the editor:
 * that focusin flips the layer back to composer. The flip only reports where the user put focus, so the composer
 * must leave the keyboard in the editor (the first keystrokes went into the chat). A flip made by navigation —
 * focus on a session row — is still a request the composer answers.
 */

const active = vi.hoisted(() => ({ store: null as unknown }))
vi.mock('@renderer/features/tabs/pane-context', () => ({
  PaneContext: React.createContext(null),
  PaneProvider: ({ children }: { children: React.ReactNode }) => children,
  usePaneContext: () => ({ isFocusedPane: React.useContext(PageShownContext), pane: { resolvedTabs: [{ isActive: true, kind: 'acp-chat', resource: { store: active.store } }] } }),
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
  value: { invoke: async () => [], eventOn: () => () => {}, eventSend: () => {}, getPathForFile: () => '',
    subscribeAppActive: (listener: (active: boolean) => void) => { listener(true); return () => {} },
  },
})
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store')
const { AcpChatPanel } = await import('@renderer/features/sessions/acp/acp-chat-panel')
let root: Root | null = null
let host: HTMLDivElement | null = null
let beside: HTMLDivElement | null = null
let store: InstanceType<typeof AcpChatStore> | null = null
let client: QueryClient | null = null

afterEach(() => {
  root?.unmount()
  host?.remove()
  beside?.remove()
  store?.dispose()
  client?.clear()
  root = host = beside = store = client = null
  active.store = null
  runInAction(() => { sessionNavigationFocus.focusLayer = 'composer' })
})

/** The chat, mounted while the focus layer is nav, next to a file editor and a session row. */
async function mountChat() {
  registerSessionLocaleResources()
  setLocalePreference('en-US')
  runInAction(() => { sessionNavigationFocus.focusLayer = 'nav' })
  store = new AcpChatStore('editor-focus', 'project')
  active.store = store
  const current = store
  runInAction(() => {
    (current as unknown as { _bootstrapped: boolean })._bootstrapped = true
    current.historyLoading = false
  })
  beside = document.createElement('div')
  beside.innerHTML = '<div role="treeitem" tabindex="0" data-testid="session-row">Codex 1</div>'
    + '<div class="cm-editor"><div class="cm-content" contenteditable="true" data-testid="file-editor">code</div></div>'
  document.body.appendChild(beside)
  host = document.createElement('div')
  host.className = 'emlight gugu-skin'
  host.style.height = '600px'
  document.body.appendChild(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  root = createRoot(host)
  renderChat(true)
  const composer = page.getByTestId('prompt-editor')
  await until('the real composer is mounted', () => composer.query() !== null)
  return {
    composer: composer.element() as HTMLElement,
    fileEditor: page.getByTestId('file-editor').element() as HTMLElement,
    sessionRow: page.getByTestId('session-row').element() as HTMLElement,
  }
}

function renderChat(shown: boolean) {
  root!.render(<PageShownContext.Provider value={shown}><LocalizationProvider><QueryClientProvider client={client!}><MessageProvider locale="en-US" translate={translateSessionMessage}><AcpChatPanel /></MessageProvider></QueryClientProvider></LocalizationProvider></PageShownContext.Provider>)
}

/** Focus lands on `element`, then the layer leaves nav (what the focusin listener / a row click does). */
function leaveNavWithFocusOn(element: HTMLElement) {
  element.focus()
  runInAction(() => { sessionNavigationFocus.focusLayer = 'composer' })
}

const frames = (n: number) => new Promise<void>((resolve) => {
  const step = () => (n-- <= 0 ? resolve() : requestAnimationFrame(step))
  step()
})

describe('composer auto-focus answers the layer leaving nav only as a request', () => {
  it('the first click into a file beside the chat keeps the keyboard in the file', async () => {
    const { fileEditor } = await mountChat()
    leaveNavWithFocusOn(fileEditor)
    await frames(5)
    expect(document.activeElement).toBe(fileEditor)
  })

  it('a session row clicked still hands the keyboard to the composer', async () => {
    const { composer, sessionRow } = await mountChat()
    expect(document.activeElement).not.toBe(composer)
    leaveNavWithFocusOn(sessionRow)
    await until('the composer takes the keyboard', () => document.activeElement === composer)
  })

  it('returning to the retained pane restores focus without remounting the composer or clearing its draft', async () => {
    const { composer, sessionRow } = await mountChat()
    leaveNavWithFocusOn(sessionRow)
    await until('initial composer focus', () => document.activeElement === composer)
    await page.getByTestId('prompt-editor').fill('Retained draft')
    renderChat(false)
    await frames(3)
    sessionRow.focus()
    expect(sessionNavigationFocus.focusLayer).toBe('composer')
    renderChat(true)
    await until('the retained composer takes focus on return', () => document.activeElement === composer)
    expect(page.getByTestId('prompt-editor').element()).toBe(composer)
    expect(composer.textContent).toBe('Retained draft')
  })

  it('returning in the navigation layer keeps the keyboard on the row', async () => {
    const { composer, sessionRow } = await mountChat()
    renderChat(false)
    await frames(3)
    sessionRow.focus()
    renderChat(true)
    await frames(5)
    expect(document.activeElement).toBe(sessionRow)
    expect(document.activeElement).not.toBe(composer)
  })

  it('an explicit entry into the same retained session focuses it even when its pane is already active', async () => {
    const { composer, sessionRow } = await mountChat()
    leaveNavWithFocusOn(sessionRow)
    await until('initial composer focus', () => document.activeElement === composer)
    sessionRow.focus()
    requestComposerEntryFocus('session:editor-focus')
    await until('the explicit same-session entry takes focus', () => document.activeElement === composer)
    const file = page.getByTestId('file-editor').element() as HTMLElement
    leaveNavWithFocusOn(file)
    await frames(5)
    expect(document.activeElement).toBe(file)
  })

  it('returning while the file editor holds focus does not take its keyboard', async () => {
    const { fileEditor } = await mountChat()
    renderChat(false)
    await frames(3)
    leaveNavWithFocusOn(fileEditor)
    renderChat(true)
    await frames(5)
    expect(document.activeElement).toBe(fileEditor)
  })
})
