// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useMessageQuote } from '../../../../apps/desktop/src/hooks/useMessageQuote'
import { contentWithQuote } from '../../../../apps/desktop/src/components/chat/messageQuoteContent'
import { createReactHarness, message } from '../../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
let state: ReturnType<typeof useMessageQuote>
function Probe({ chatId = 'topic-1' }: { chatId?: string }) {
  state = useMessageQuote(chatId, () => 'Ada', '[附件]')
  return null
}
beforeEach(async () => { h = createReactHarness(); await h.render(createElement(Probe)) })
afterEach(() => h.cleanup())

it('keeps an attachment display label out of the transmitted reply body', async () => {
  await act(async () => state.onQuote(message({ content_type: 'attachment', content: '[附件] notes.txt (text/plain)\n[Kind] file' })))
  expect(state.quote?.content).toBe('[附件]')
  expect(state.quote?.originalContent).toBeUndefined()
  expect(contentWithQuote('看看', state.quote)).toBe('看看')
})

it('preserves explicit excerpts, the source and the native cancellation token', async () => {
  const source = message({ id: 'source', content: 'Beta', is_whisper: true, to_user_ids: ['peer'] })
  await act(async () => state.onQuote(source, { originalContent: 'Alpha Beta', selectionId: 'range-1' }))
  expect(state.quote).toMatchObject({ messageId: 'source', content: 'Beta', originalContent: 'Alpha Beta', selectionId: 'range-1', source })
  expect(contentWithQuote('Explain', state.quote)).toBe('> [Ada]: Beta\n\nExplain')
  await act(async () => state.onQuote(source, { originalContent: 'Alpha Beta', selectionId: 'stale', clear: true }))
  expect(state.quote?.selectionId).toBe('range-1')
  await act(async () => state.onQuote(source, { originalContent: 'Alpha Beta', selectionId: 'range-1', clear: true }))
  expect(state.quote).toBeNull()
})

it('does not cancel a manually attached quote without its own native selection token', async () => {
  const source = message({ id: 'source', content: 'Alpha Beta' })
  await act(async () => state.onQuote(source))
  await act(async () => state.onQuote(source, { originalContent: source.content, clear: true }))
  expect(state.quote?.messageId).toBe('source')
})

it('does not carry a quote from one topic into another topic or its send path', async () => {
  await act(async () => state.onQuote(message({ id: 'source' })))
  await h.render(createElement(Probe, { chatId: 'topic-2' }))
  expect(state.quote).toBeNull()
  expect(contentWithQuote('Other topic', state.quote)).toBe('Other topic')
})
