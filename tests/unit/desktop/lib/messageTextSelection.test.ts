// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeMessageTextSelection } from '../../../../apps/desktop/src/lib/messageTextSelection'

// Opt-in contract for the follow-up rollout; production defaults are covered separately.
vi.mock('../../../../apps/desktop/src/lib/messageQuoteRollout', () => ({ SELECTED_MESSAGE_QUOTES_ENABLED: true }))
let root: HTMLDivElement
let cleanups: (() => void)[]
beforeEach(() => {
  root = document.createElement('div')
  root.innerHTML = '<p>Alpha paragraph.</p><p>Beta <strong>bold words</strong>.</p><ol><li>First item.</li><li>Second item.</li></ol><pre><code>const x = 42;</code></pre>'
  document.body.append(root)
  cleanups = []
})
afterEach(() => {
  cleanups.forEach(cleanup => cleanup())
  root.remove()
  window.getSelection()?.removeAllRanges()
})
function select(start: Node, end = start) {
  const range = document.createRange()
  range.setStart(start, 0)
  range.setEnd(end, end.textContent!.length)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}
function release() { document.dispatchEvent(new Event('touchend')) }
function observe(enabled = true) {
  const onQuote = vi.fn()
  const onClearQuote = vi.fn()
  const onContext = vi.fn()
  cleanups.push(observeMessageTextSelection(root, { enabled, onQuote, onClearQuote, onContext }))
  return { onQuote, onClearQuote, onContext }
}
describe('renderer-independent mobile message selection', () => {
  it('waits for touch release, then quotes text spanning paragraphs, strong, list items and code', () => {
    const { onQuote } = observe()
    select(root.querySelector('p')!.firstChild!, root.querySelector('code')!.firstChild!)
    expect(onQuote).not.toHaveBeenCalled()
    release()
    expect(onQuote).toHaveBeenCalledOnce()
    expect(onQuote.mock.calls[0][0]).toContain('Beta bold words.')
    expect(onQuote.mock.calls[0][0]).toContain('First item.Second item.')
    expect(onQuote.mock.calls[0][0]).toContain('const x = 42;')
  })
  it('does nothing on desktop even if text is selected and a touch release is dispatched', () => {
    const { onQuote, onContext } = observe(false)
    select(root.querySelector('p')!.firstChild!)
    release()
    expect(onQuote).not.toHaveBeenCalled()
    expect(onContext).not.toHaveBeenCalled()
  })
  it('rejects a nonempty selection spanning two message roots and clears only its own automatic quote', () => {
    const { onQuote, onClearQuote } = observe()
    const other = document.createElement('p')
    other.textContent = 'Another message'
    root.after(other)
    select(root.querySelector('p')!.firstChild!)
    release()
    const token = onQuote.mock.calls[0][1]
    select(root.querySelector('p')!.firstChild!, other.firstChild!)
    release()
    expect(onQuote).toHaveBeenCalledOnce()
    expect(onClearQuote).toHaveBeenCalledWith(token)
    other.remove()
  })
  it('keeps the composer quote after native Copy collapses the range', () => {
    const { onQuote, onClearQuote } = observe()
    select(root.querySelector('p')!.firstChild!)
    release()
    window.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    expect(onQuote).toHaveBeenCalledOnce()
    expect(onClearQuote).not.toHaveBeenCalled()
  })
  it('does not clear its quote when text outside messages is selected', () => {
    const { onClearQuote } = observe()
    select(root.querySelector('p')!.firstChild!)
    release()
    const outside = document.createTextNode('composer text')
    document.body.append(outside)
    select(outside)
    release()
    expect(onClearQuote).not.toHaveBeenCalled()
    outside.remove()
  })
  it('quotes only once for repeated native menu preparation of the same selection', () => {
    const { onQuote } = observe()
    select(root.querySelector('p')!.firstChild!)
    document.dispatchEvent(new Event('gugu:message-selection-settled'))
    document.dispatchEvent(new Event('gugu:message-selection-settled'))
    release()
    expect(onQuote).toHaveBeenCalledOnce()
  })
  it('does not keep event listeners after the renderer unmounts', () => {
    const { onQuote } = observe()
    cleanups.pop()!()
    select(root.querySelector('p')!.firstChild!)
    release()
    expect(onQuote).not.toHaveBeenCalled()
  })
})
