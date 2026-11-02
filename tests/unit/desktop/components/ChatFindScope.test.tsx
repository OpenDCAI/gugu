// @vitest-environment jsdom
import { act, useRef, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder'
import { FindBar } from '@renderer/lib/ui/find-bar'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { resetSearchSession, useSearchSession } from '@renderer/features/global-search/search-session'
import { useMessageFind } from '../../../../apps/desktop/src/components/chat/useMessageFind'
import { useChatSearch } from '../../../../apps/desktop/src/components/chat/useChatSearch'
import { clickElement, createReactHarness, typeInto } from '../../../support/testHarness'
import type { FlowListHandle } from '../../../../apps/desktop/src/lib/flowList'

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))
const EMPTY: [] = []
function Conversation({ id, children }: { id: string; children?: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null), scrollerRef = useRef<HTMLDivElement>(null), listRef = useRef<FlowListHandle>(null)
  const search = useChatSearch(id, true, EMPTY, rootRef, id)
  const find = useMessageFind({ chatId: id, messages: EMPTY, rows: EMPTY, rootRef, scrollerRef, listRef, enabled: true, search })
  const globalSearch = useSearchSession()
  return <div ref={rootRef} data-chat-surface={id} data-search-mode={search.searchMode}><button data-focus={id}>Focus {id}</button><FindBar {...find} onSearchAll={find.searchAll} /><output data-search-session>{JSON.stringify(globalSearch)}</output>{children}</div>
}
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); resetSearchSession() })
it('k1 routes a topic find to its own pane when nested inside the source conversation', async () => {
  harness = createReactHarness()
  await harness.render(<><CommandShortcutBinder /><Conversation id="group"><Conversation id="topic" /></Conversation></>)
  const topic = harness.container.querySelector<HTMLButtonElement>('[data-focus=topic]')!
  await act(async () => topic.focus())
  await act(async () => topic.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true })))
  const finds = harness.container.querySelectorAll('input')
  expect(finds).toHaveLength(1)
  expect(finds[0]!.closest('[data-chat-surface]')?.getAttribute('data-chat-surface')).toBe('topic')
  expect(document.activeElement).toBe(finds[0])
})

it.each(['group', 'topic'])('k8 hands the %s query to global search with its own conversation scope', async (id) => {
  const openPanel = vi.fn()
  const unregister = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.globalSearch', execute: openPanel }] })
  try {
    harness = createReactHarness()
    await harness.render(<><CommandShortcutBinder /><Conversation id="group"><Conversation id="topic" /></Conversation></>)
    const focus = harness.container.querySelector<HTMLButtonElement>(`[data-focus=${id}]`)!
    await act(async () => focus.focus())
    await act(async () => focus.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true })))
    await typeInto(harness.container.querySelector('input')!, 'needle')
    const searchAll = [...harness.container.querySelectorAll('button')].find((button) => button.textContent === 'find.searchAll')!
    await clickElement(searchAll)
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('input')).toBeNull()
    expect(harness.container.querySelector('[data-search-mode=true]')).toBeNull()
    const state = JSON.parse(harness.container.querySelector('[data-search-session]')!.textContent!)
    expect(state.text).toBe('needle')
    expect(state.chips).toEqual([{ kind: 'in', chatId: id }])
  } finally { unregister() }
})
