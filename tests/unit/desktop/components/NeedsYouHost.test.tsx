import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Settlement } from '@gugu/session-core/session-record/contract'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { NeedsYouHost } from '../../../../apps/desktop/src/components/needsYou/NeedsYouHost'

const state = vi.hoisted(() => ({ tasks: [] as unknown[], settlements: {} as Record<string, unknown>, link: 'ok' }))
const close = vi.hoisted(() => vi.fn())
const respond = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/components/needsYou/useNeedsYouTasks', () => ({ useNeedsYouTasks: () => ({ tasks: state.tasks, error: null }) }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => false }))
vi.mock('@/mobile/agent-watch/use-timeline-session', () => ({ useTimelineSession: () => ({ timeline: { settlements: state.settlements }, phase: 'ready', link: state.link, respond }) }))
vi.mock('@/components/assistant/assistantTimelineClient', () => ({ assistantTimelineClient: () => ({}) }))
vi.mock('@/components/chat/openTaskCardSession', () => ({ openTaskCardSession: vi.fn() }))
vi.mock('@/session/renderer/features/extensions/install-consent', () => ({ closeInShell: close }))
vi.mock('@/components/ui/Sheet', () => ({ Sheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div> }))
vi.mock('@/mobile/agent-watch/TimelineView', () => ({ SettlementCard: ({ settlement, onRespond }: { settlement: Settlement; onRespond: (answer: unknown) => void }) =>
  <button data-item-id={settlement.itemId} onClick={() => onRespond({ itemId: settlement.itemId, kind: settlement.kind, optionId: 'allow' })}>{settlement.title}</button> }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.clearAllMocks()
  state.tasks = [{ deviceId: 'server', machine: 'Remote host', local: false, session: { conversationId: 'task', title: 'Install Reader', projectId: 'project', runtime: 'pty' } }]
  state.settlements = { install: { itemId: 'install', kind: 'permission', title: 'Review Reader', state: 'pending', host: { kind: 'app-install', payload: { request: {} } } } }
  state.link = 'ok'
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())
const render = () => renderWithAppProviders(harness, <><main>Group conversation</main><NeedsYouHost /></>)
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
