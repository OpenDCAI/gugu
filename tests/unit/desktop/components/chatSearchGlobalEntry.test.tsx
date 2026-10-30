// @vitest-environment jsdom
import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ enabled: false, opened: [] as unknown[] }))
vi.mock('@renderer/features/global-search/global-search-flag', () => ({ globalSearchV3Enabled: () => state.enabled, useGlobalSearchV3: () => state.enabled }))
vi.mock('@renderer/features/global-search/search-session', () => ({
  openGlobalSearch: (options: unknown) => { state.opened.push(options) },
  findMemberMessages: (chatId: string, userId: string) => { state.opened.push({ chatId, userId }) },
}))
vi.mock('@renderer/lib/commands/use-command-provider', () => ({ useCommandProvider: () => {} }))
import { useChatSearch } from '../../../../apps/desktop/src/components/chat/useChatSearch'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'

function Probe({ onMode }: { onMode: (mode: boolean) => void }) {
  const surface = useRef<HTMLElement | null>(null)
  const search = useChatSearch('chat-1', true, [], surface, 'primary')
  onMode(search.searchMode)
  return null
}

async function openFromChat(enabled: boolean) {
  state.enabled = enabled
  state.opened = []
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let mode = false
  const root = createRoot(document.createElement('div'))
  await act(async () => { root.render(<Probe onMode={(value) => { mode = value }} />) })
  await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatSearch, { detail: { chatId: 'chat-1', viewportKey: 'primary' } })) })
  act(() => root.unmount())
  return { mode, opened: state.opened }
}

describe('in-chat search entry', () => {
  it('opens only the global search modal, scoped to the chat, while globalSearch.v3 is on', async () => {
    expect(await openFromChat(true)).toEqual({ mode: false, opened: [{ chips: [{ kind: 'in', chatId: 'chat-1' }] }] })
  })
  it('keeps the existing in-window search while the flag is off', async () => {
    expect(await openFromChat(false)).toEqual({ mode: true, opened: [] })
  })
})

describe("a member's messages in this chat", () => {
  it.each([[true, [{ chatId: 'chat-1', userId: 'member-1' }]], [false, []]])('are offered to profile cards only with the flag on (%s)', async (enabled, expected) => {
    state.enabled = enabled
    state.opened = []
    let find: ((userId: string) => void) | undefined
    function Cards() {
      const surface = useRef<HTMLElement | null>(null)
      find = useChatSearch('chat-1', true, [], surface, 'primary').findMessagesOf
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => { root.render(<Cards />) })
    find?.('member-1')
    act(() => root.unmount())
    expect(state.opened).toEqual(expected)
  })
})
