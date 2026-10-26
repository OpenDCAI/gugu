// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Settlement } from '@gugu/session-core/session-record/contract'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { showPhoneAppView } from '../../../../apps/desktop/src/components/appSlot/phoneAppState'
import { setEmbedVisible } from '../../../../apps/desktop/src/session/renderer/lib/portal-container'
import { NeedsYouSlot } from '../../../../apps/desktop/src/components/needsYou/NeedsYouSlot'
import { installShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { NeedsYouHost } from '../../../../apps/desktop/src/components/needsYou/NeedsYouHost'

const state = vi.hoisted(() => ({ tasks: [] as unknown[], settlements: {} as Record<string, unknown>, link: 'ok', mobile: false, pages: [] as { projectId: string; sessionId: string }[], wholePage: true, tab: 'acp-chat' }))
const followLink = vi.hoisted(() => vi.fn())
const close = vi.hoisted(() => vi.fn())
const respond = vi.hoisted(() => vi.fn(async () => undefined))
const timeline = vi.hoisted(() => vi.fn((..._args: unknown[]) => ({ timeline: { settlements: state.settlements }, phase: 'ready', link: state.link, respond })))
vi.mock('@/components/needsYou/useNeedsYouTasks', () => ({ useNeedsYouTasks: () => ({ tasks: state.tasks, error: null }) }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => state.mobile }))
vi.mock('@/mobile/agent-watch/use-timeline-session', () => ({ useTimelineSession: timeline }))
vi.mock('@/components/assistant/assistantTimelineClient', () => ({ assistantTimelineClient: () => ({}) }))
vi.mock('@/lib/guguLinks', () => ({ followLink }))
vi.mock('@/session/renderer/app/sessions-on-screen', () => ({ sessionPagesOnScreen: () => state.pages, sessionPageOnScreen: () => state.wholePage }))
vi.mock('@/session/renderer/features/sessions/stores/session-selectors', () => ({ getSessionView: () => ({ paneLayout: { groups: [{ pane: { activeEntry: { kind: state.tab, state: { sessionId: 'task' } } } }] } }) }))
vi.mock('@/session/renderer/features/extensions/install-consent', () => ({ closeInShell: close }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div> }))
vi.mock('@/mobile/agent-watch/TimelineView', () => ({ SettlementCard: ({ settlement, onRespond, source }: { settlement: Settlement; onRespond: (answer: unknown) => void; source?: ReactNode }) =>
  <div>{source}<button data-item-id={settlement.itemId} onClick={() => onRespond({ itemId: settlement.itemId, kind: settlement.kind, optionId: 'allow' })}>{settlement.title}</button></div> }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks()
  installShellSlots()
  state.tasks = [{ deviceId: 'server', machine: 'Remote host', local: false, session: { conversationId: 'task', title: 'Install Reader', projectId: 'project', runtime: 'pty', supported: true } }]
  state.settlements = { install: { itemId: 'install', kind: 'permission', title: 'Review Reader', state: 'pending', host: { kind: 'app-install', payload: { request: {} } } } }
  state.link = 'ok'
  state.mobile = false
  state.pages = []
  state.wholePage = true
  state.tab = 'acp-chat'
  setEmbedVisible(true)
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())
const render = () => renderWithAppProviders(harness, <><main>Group conversation<NeedsYouSlot /></main><NeedsYouHost /></>)
async function open() {
  await render()
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="needs-you-trigger"]')!.click() })
}
it('opens the same pending settlement over a group without navigating away', async () => {
  await open()
  expect(harness.container.textContent).toContain('Group conversation')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Review Reader')
  await act(async () => { document.querySelector<HTMLButtonElement>('[data-item-id="install"]')!.click() })
  expect(respond).toHaveBeenCalledWith({ itemId: 'install', kind: 'permission', optionId: 'allow' })
  expect(timeline.mock.calls.at(-1)?.[1]).toBe('desktop')
})
it('marks the automatically opened single task as selected with its task title', async () => {
  await open()
  const row = document.querySelector('[data-testid="needs-you-task"]')!
  expect(row.getAttribute('aria-pressed')).toBe('true')
  expect(row.querySelector('.gg-list-row-title')?.textContent).toBe('Install Reader')
})
it.each(['Enter', ' '])('selects a task from the list with the %s key without navigating or answering', async key => {
  state.tasks.push({ deviceId: 'server', machine: 'Other host', local: false, session: { conversationId: 'other', title: 'Review destination', projectId: 'project', runtime: 'pty', supported: true } })
  await open()
  expect(document.querySelector('[data-testid="needs-you-source-link"]')).toBeNull()
  const row = document.querySelectorAll('[data-testid="needs-you-task"]')[1]
  await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  expect(row.getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('[data-testid="needs-you-source-link"]')?.textContent).toContain('Review destination')
  expect(followLink).not.toHaveBeenCalled()
  expect(respond).not.toHaveBeenCalled()
})
it('withdraws an open install sheet when its host cancels or another screen answers', async () => {
  await open()
  state.settlements = { install: { ...state.settlements.install as object, state: 'cancelled' } }
  await render()
  expect(close).toHaveBeenCalledWith('install')
  expect(document.querySelector('[data-item-id="install"]')).toBeNull()
})
it('closes both pending surfaces when the task leaves Needs you', async () => {
  await open()
  state.tasks = []
  await render()
  expect(close).toHaveBeenCalledWith('install')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).toBeNull()
})
it('does not offer stale approvals after losing the host connection', async () => {
  await open()
  state.link = 'lost'
  await render()
  expect(close).toHaveBeenCalledWith('install')
  expect(document.querySelector('[data-item-id="install"]')).toBeNull()
})
it('uses the same pending surface for questions and tool approvals', async () => {
  state.settlements = {
    question: { itemId: 'question', kind: 'question', title: 'Choose destination', state: 'pending' },
    tool: { itemId: 'tool', kind: 'permission', title: 'Allow tool', state: 'pending' },
  }
  await open()
  expect(document.querySelector('[data-item-id="question"]')).not.toBeNull()
  expect(document.querySelector('[data-item-id="tool"]')).not.toBeNull()
})
it('records a phone answer using the existing mobile responder identity', async () => {
  state.mobile = true
  await open()
  expect(timeline.mock.calls.at(-1)?.[1]).toBe('mobile')
})

it.each([false, true])('opens the task from its quiet source link without answering (mobile=%s)', async mobile => {
  state.mobile = mobile
  await open()
  const source = document.querySelector<HTMLButtonElement>('[data-testid="needs-you-source-link"]')!
  expect(source.getAttribute('role')).toBe('link')
  expect(source.textContent).toContain('Install Reader')
  expect(document.querySelector('[data-testid="needs-you-open-page"]')).toBeNull()
  expect(document.querySelector('[data-item-id="install"]')).not.toBeNull()
  await act(async () => { source.click() })
  expect(followLink).toHaveBeenCalledWith({ kind: 'session', sessionId: 'task' })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(respond).not.toHaveBeenCalled()
})
it('hides only the task with a visible agent pane and restores it when leaving', async () => {
  state.pages = [{ projectId: 'project', sessionId: 'task' }]
  await render()
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).toBeNull()
  await act(async () => setEmbedVisible(false))
  await render()
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).not.toBeNull()
})
it('keeps the global request when the task shows a file or App instead of its agent', async () => {
  state.pages = [{ projectId: 'project', sessionId: 'task' }]
  state.tab = 'file'
  await open()
  expect(document.querySelector('[data-item-id="install"]')).not.toBeNull()
})
it('keeps global access when only a detached file tab belongs to the waiting task', async () => {
  state.pages = [{ projectId: 'project', sessionId: 'task' }]
  state.wholePage = false
  await open()
  expect(document.querySelector('[data-item-id="install"]')).not.toBeNull()
})
it('keeps requests for other tasks while hiding the current task', async () => {
  state.pages = [{ projectId: 'project', sessionId: 'other' }]
  await open()
  expect(document.querySelector('[data-item-id="install"]')).not.toBeNull()
})
it('uses the phone timeline route and restores the pending request on exit', async () => {
  state.mobile = true
  await render()
  let leave!: () => void
  await act(async () => { leave = showPhoneAppView({ activeSessionId: 'task', activeProjectId: 'project', panes: [{ paneId: 'workspace', focused: true, activeTab: { tabId: 'task', kind: 'session' } }] }) })
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).toBeNull()
  await act(async () => leave())
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).not.toBeNull()
})
it('keeps the phone request while a session App replaces the timeline', async () => {
  state.mobile = true
  const leave = showPhoneAppView({ activeSessionId: 'task', activeProjectId: 'project', panes: [{ paneId: 'workspace', focused: true, activeTab: { tabId: 'app', kind: 'app:reader' } }] })
  try {
    await open()
    expect(document.querySelector('[data-item-id="install"]')).not.toBeNull()
  } finally { await act(async () => leave()) }
})

it('has no floating entry on a page without a composer slot', async () => {
  await renderWithAppProviders(harness, <><main>Settings</main><NeedsYouHost /></>)
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).toBeNull()
})

it('reports waiting tasks to the existing rail even when the current task has its own approval', async () => {
  const onNeedsUserChange = vi.fn()
  state.pages = [{ projectId: 'project', sessionId: 'task' }]
  await renderWithAppProviders(harness, <NeedsYouHost onNeedsUserChange={onNeedsUserChange} />)
  expect(onNeedsUserChange).toHaveBeenLastCalledWith(true)
  expect(document.querySelector('[data-testid="needs-you-trigger"]')).toBeNull()
  state.tasks = []
  await renderWithAppProviders(harness, <NeedsYouHost onNeedsUserChange={onNeedsUserChange} />)
  expect(onNeedsUserChange).toHaveBeenLastCalledWith(false)
})
