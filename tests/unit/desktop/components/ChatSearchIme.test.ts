// @vitest-environment jsdom
import { act, createElement, useMemo, useRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatSearchControls } from '../../../../apps/desktop/src/components/chat/ChatSearch'
import { useChatSearch } from '../../../../apps/desktop/src/components/chat/useChatSearch'
import { useFollowingTail } from '../../../../apps/desktop/src/components/chat/useFollowingTail'
import { useFlowList } from '../../../../apps/desktop/src/lib/flowList'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { createReactHarness, message, typeInto } from '../../../support/testHarness'
import type { MessageItem } from '@gugu/core/shared/types/chat'

const messages = [message({ content: '中文 needle' }), message({ id: 'message-2', content: 'other' })]
const noop = () => {}
const notPreserving = () => false
let harness: ReturnType<typeof createReactHarness>
const queries: string[] = []

// The real list mounts only when search has results. Keep its real first-paint and
// following hooks; jsdom's empty geometry is sufficient to report "at bottom".
function Results({ rows, report }: { rows: MessageItem[]; report: (bottom: boolean) => void }) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows])
  const { start, end } = useFlowList({ scrollerRef, contentRef, rowIds, resetKey: 'chat-1',
    landing: { index: 'LAST', align: 'end' }, followTail: true, atBottomThreshold: 80, onAtBottomChange: report })
  return createElement('div', { ref: scrollerRef }, createElement('div', { ref: contentRef },
    rows.slice(start, end).map((row) => createElement('p', { key: row.id }, row.content))))
}

function Search() {
  const surface = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const search = useChatSearch('chat-1', true, messages, surface, 'test')
  const { onAtBottomChange } = useFollowingTail({ resetKey: 'chat-1', unreadNavigationPending: false,
    hasNewer: false, loading: false, isPreservingPosition: notPreserving, isAtBottomRef, setFollowingTail: noop })
  queries.push(search.searchQuery)
  return createElement('div', { ref: surface },
    search.searchMode && createElement(ChatSearchControls, { search }),
    search.displayedMessages.length > 0 && createElement(Results, { rows: search.displayedMessages, report: onAtBottomChange }))
}

async function open() {
  harness = createReactHarness()
  queries.length = 0
  await harness.render(createElement(Search))
  await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatSearch, { detail: { viewportKey: 'test' } })) })
  return harness.container.querySelector<HTMLInputElement>('input')!
}

async function compose(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: value }))
  })
}

afterEach(() => harness?.cleanup())

describe('chat search input and list first paint', () => {
  it('commits Chinese composition once without re-entering the first-paint report', async () => {
    const input = await open()
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    await compose(input, 'z')
    await compose(input, 'zhong')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', isComposing: true })) })
    expect(harness.container.querySelector('input')).toBe(input)
    await compose(input, '中文')
    await act(async () => { input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })) })
    expect(queries.filter(Boolean)).toEqual(expect.arrayContaining(['中文']))
    expect(queries).not.toContain('z')
    expect(queries).not.toContain('zhong')
    expect(harness.container.querySelectorAll('p')).toHaveLength(1)
    expect(harness.container.querySelector('p')?.textContent).toBe('中文 needle')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })) })
    expect(harness.container.querySelector('input')).toBeNull()
  })

  it('can mount English matches after an empty result and clear them', async () => {
    const input = await open()
    await typeInto(input, 'no match')
    expect(harness.container.querySelectorAll('p')).toHaveLength(0)
    await typeInto(input, 'needle')
    expect(harness.container.querySelectorAll('p')).toHaveLength(1)
    await typeInto(input, '')
    expect(harness.container.querySelectorAll('p')).toHaveLength(2)
  })
})
