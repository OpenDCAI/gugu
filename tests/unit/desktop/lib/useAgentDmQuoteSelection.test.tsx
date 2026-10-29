// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ChatMessage } from '@gugu/session-chat-ui'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { useAgentDmQuoteSelection } from '../../../../apps/desktop/src/hooks/useAgentDmQuoteSelection'
import { contentWithQuote } from '../../../../apps/desktop/src/components/chat/messageQuoteContent'
import { createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
let api: ReturnType<typeof useAgentDmQuoteSelection>
let roots: HTMLDivElement[]
const source = message({ id: 'im-1', content: 'Alpha Beta', sender_user_id: 'agent-1' })
function Probe({ messages = [source], aliases = new Map([['row-1', ['im-1']]]), mobile = true }: {
  messages?: MessageItem[]; aliases?: ReadonlyMap<string, readonly string[]>; mobile?: boolean
}) {
  api = useAgentDmQuoteSelection({ chatId: 'dm-1', mobile, messages, aliases, names: { 'agent-1': { display_name: 'Ada' } }, agentName: 'Ada' })
  return createElement(Fragment, null, api.toolbar)
}
beforeEach(() => { h = createReactHarness(); roots = [] })
afterEach(() => { h.cleanup(); roots.forEach(root => root.remove()); window.getSelection()?.removeAllRanges() })
function mount(id = 'row-1') {
  const root = document.createElement('div'); root.innerHTML = '<p>Beta</p>'
  document.body.append(root); roots.push(root)
  const item: ChatMessage = { kind: 'message', id, role: 'assistant', text: 'Alpha Beta' }
  api.onMessageTextMount!({ root, itemId: id, message: () => item })
  return root
}
async function select(start: HTMLElement, end = start) {
  const range = document.createRange(); range.setStart(start.querySelector('p')!.firstChild!, 0)
  range.setEnd(end.querySelector('p')!.firstChild!, 4)
  await act(async () => {
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange')); document.dispatchEvent(new Event('touchend'))
  })
}
it('uses explicit provenance to preserve the IM reply link and selected excerpt', async () => {
  await renderWithAppProviders(h, createElement(Probe))
  await select(mount())
  expect(api.quoteContent).toMatchObject({ messageId: 'im-1', senderName: 'Ada', content: 'Beta', originalContent: 'Alpha Beta', selectionId: expect.any(String) })
  expect(contentWithQuote('Explain', api.quoteContent)).toBe('> [Ada]: Beta\n\nExplain')
})
it('quotes a timeline-only answer without inventing an IM message ID', async () => {
  await renderWithAppProviders(h, createElement(Probe, { aliases: new Map() }))
  await select(mount('timeline-only'))
  expect(api.quoteContent?.content).toBe('Beta')
  expect(api.quoteContent?.messageId).toBeUndefined()
})
it('never attaches a single quote to a row with provenance from two messages', async () => {
  await renderWithAppProviders(h, createElement(Probe, { aliases: new Map([['row-1', ['im-1', 'im-2']]]) }))
  await select(mount())
  expect(api.quoteContent).toBeNull()
})
it('clears its automatically attached quote when the selection crosses message roots', async () => {
  await renderWithAppProviders(h, createElement(Probe))
  const first = mount(), second = mount('timeline-only')
  await select(first); expect(api.quoteContent).not.toBeNull()
  await select(first, second); expect(api.quoteContent).toBeNull()
})
it.each(['attachment', 'card'] as const)('leaves a non-text %s row to its existing menu', async content_type => {
  await renderWithAppProviders(h, createElement(Probe, { messages: [{ ...source, content_type }] }))
  await select(mount())
  expect(api.quoteContent).toBeNull()
})
it('does not bind native text selection on desktop', async () => {
  await renderWithAppProviders(h, createElement(Probe, { mobile: false }))
  expect(api.onMessageTextMount).toBeUndefined()
})
