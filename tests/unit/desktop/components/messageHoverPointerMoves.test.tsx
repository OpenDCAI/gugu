// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { MessageHoverRegion, MessageHoverTrigger } from '../../../../apps/desktop/src/components/chat/HoverActionBar'

/**
 * A long list scrolled under a still pointer: Chromium sends each row sliding by only boundary events (mouseover / mouseenter), at
 * the spot where the mouse last moved, and no move. Every such row used to open (mount) its hover bar, and each mount paid
 * floating-ui autoUpdate's overflow-ancestor walk: 76% of the busy time scrolling a 7k-message topic. A pointer moving onto a
 * row enters at a new spot (the boundary events come before that move's mousemove).
 */
describe('message hover bar opens for a moving pointer, not for a row scrolled under a still one', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => harness.cleanup())

  const at = (type: string, x: number) => new MouseEvent(type, { bubbles: type !== 'mouseenter', clientX: x, clientY: 10 })
  async function renderRow() {
    await harness.render(
      <MessageHoverRegion enabled forceOpen={false} style={{}} actions={<span data-bar="row" />}>
        <MessageHoverTrigger data-testid="row">row</MessageHoverTrigger>
      </MessageHoverRegion>,
    )
    const row = harness.container.querySelector<HTMLElement>('[data-testid="row"]')!
    document.dispatchEvent(at('mousemove', 10)) // the pointer last moved here, outside this row
    return row
  }
  const bar = () => harness.container.querySelector('[data-bar]')

  it('a row scrolled under the still pointer stays closed until the pointer moves on it', async () => {
    const row = await renderRow()
    await act(async () => { row.dispatchEvent(at('mouseenter', 10)) })
    expect(bar(), 'entered where the mouse already was: the content moved, not the pointer').toBeNull()
    await act(async () => { row.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 12, clientY: 10 })) })
    expect(bar(), 'the next real move on the row opens it').not.toBeNull()
  })

  it('a pointer that moves onto the row opens it at once', async () => {
    const row = await renderRow()
    await act(async () => { row.dispatchEvent(at('mouseenter', 14)) })
    expect(bar()).not.toBeNull()
  })
})
