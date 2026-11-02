// @vitest-environment jsdom
import { act, useRef, type ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CommandShortcutBinder } from '@renderer/lib/commands/command-shortcut-binder'
import { FindBar } from '@renderer/lib/ui/find-bar'
import { useMessageFind } from '../../../../apps/desktop/src/components/chat/useMessageFind'
import { useChatSearch } from '../../../../apps/desktop/src/components/chat/useChatSearch'
import { createReactHarness } from '../../../support/testHarness'
import type { FlowListHandle } from '../../../../apps/desktop/src/lib/flowList'

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }))
const EMPTY: [] = []
function Conversation({ id, children }: { id: string; children?: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null), scrollerRef = useRef<HTMLDivElement>(null), listRef = useRef<FlowListHandle>(null)
  const search = useChatSearch(id, true, EMPTY, rootRef, id)
  const find = useMessageFind({ messages: EMPTY, rows: EMPTY, rootRef, scrollerRef, listRef, enabled: true, search })
  return <div ref={rootRef} data-chat-surface={id}><button data-focus={id}>Focus {id}</button><FindBar {...find} />{children}</div>
}
let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())
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
