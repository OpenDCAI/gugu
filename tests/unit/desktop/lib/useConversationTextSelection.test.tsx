// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@gugu/session-chat-ui'
import { useConversationTextSelection } from '../../../../apps/desktop/src/hooks/useConversationTextSelection'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
let api: ReturnType<typeof useConversationTextSelection>
let roots: HTMLDivElement[]
const quote = vi.fn(), clear = vi.fn()
function Probe({ enabled = true }: { enabled?: boolean }) {
  api = useConversationTextSelection({ enabled, onQuote: quote, onClearQuote: clear, actions: () => [] })
  return createElement(Fragment, null, api.toolbar)
}
beforeEach(() => { h = createReactHarness(); roots = []; quote.mockReset(); clear.mockReset() })
afterEach(() => { h.cleanup(); roots.forEach(root => root.remove()); window.getSelection()?.removeAllRanges() })
const message = (id: string): ChatMessage => ({ kind: 'message', id, role: 'assistant', text: 'Alpha Beta' })
function mount(id: string) {
  const root = document.createElement('div'); root.innerHTML = '<p>Beta</p>'; root.style.userSelect = 'none'
  document.body.append(root); roots.push(root)
  let current = message(id)
  const dispose = api.onMessageTextMount!({ root, itemId: id, message: () => current })!
  return { root, dispose, replace: (next: ChatMessage) => { current = next } }
}
async function select(start: HTMLElement, end = start) {
  const range = document.createRange(); range.setStart(start.querySelector('p')!.firstChild!, 0)
  range.setEnd(end.querySelector('p')!.firstChild!, 4)
  await act(async () => {
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange')); document.dispatchEvent(new Event('touchend'))
  })
}
it('adapts a transcript body root and reads its current message when the gesture ends', async () => {
  await renderWithAppProviders(h, createElement(Probe))
  const item = mount('one'), updated = { ...message('one'), text: 'Alpha Beta updated' }
  item.replace(updated)
  await select(item.root)
  expect(quote).toHaveBeenCalledWith(updated, 'Beta', expect.any(String))
  expect(item.root.style.userSelect).toBe('text')
  await act(async () => item.dispose())
  expect(item.root.style.userSelect).toBe('none')
})
it('clears only its own quote when selection crosses two transcript messages', async () => {
  await renderWithAppProviders(h, createElement(Probe))
  const first = mount('one'), second = mount('two')
  await select(first.root)
  const id = quote.mock.calls[0][2]
  await select(first.root, second.root)
  expect(quote).toHaveBeenCalledOnce()
  expect(clear).toHaveBeenCalledWith(id)
})
it('releases mounted row observers when the React host unmounts', async () => {
  await renderWithAppProviders(h, createElement(Probe))
  const item = mount('one')
  await h.render(null)
  await select(item.root)
  expect(quote).not.toHaveBeenCalled()
  expect(item.root.style.userSelect).toBe('none')
})
it('offers no selection binding on desktop', async () => {
  await renderWithAppProviders(h, createElement(Probe, { enabled: false }))
  expect(api.onMessageTextMount).toBeUndefined()
})
