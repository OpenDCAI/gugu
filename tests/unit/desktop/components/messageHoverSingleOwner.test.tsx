// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { PreviewCard } from '@base-ui/react/preview-card'
import { createReactHarness } from '../../../support/testHarness'
import { MessageHoverRegion, MessageHoverTrigger } from '../../../../apps/desktop/src/components/chat/HoverActionBar'
import { claimHoverOwner, readHoverOwner, releaseHoverOwner, subscribeHoverOwner } from '../../../../apps/desktop/src/components/chat/hover-owner'

/**
 * 气泡上的悬浮操作条任何时刻最多一个(owner 10-28:划过时偶尔同时出现两个)。
 * 实机复现的两种:换行时新旧叠约 200ms(各自的 close delay);一行的「更多」开着时再悬到别的行。
 */
describe('message hover bar: one row owns it at a time', () => {
  const a = Symbol('a')
  const b = Symbol('b')
  afterEach(() => {
    releaseHoverOwner(a)
    releaseHoverOwner(b)
  })

  it('the row that opens takes it over from the row before, at once', () => {
    expect(claimHoverOwner(a)).toBe(true)
    expect(claimHoverOwner(b)).toBe(true)
    // a lost it: claiming again is a fresh hand-over, not a second bar.
    expect(claimHoverOwner(a)).toBe(true)
  })

  it('a row whose menu is open (forceOpen) keeps it; another row cannot take it until the menu closes', () => {
    expect(claimHoverOwner(a, true)).toBe(true)
    expect(claimHoverOwner(b)).toBe(false)
    releaseHoverOwner(b) // not the owner: no effect
    expect(claimHoverOwner(b)).toBe(false)
    releaseHoverOwner(a)
    expect(claimHoverOwner(b)).toBe(true)
  })

  it.each([false, true])('protects travel toward the actual popup, including flipped placement (below: %s)', (below) => {
    const trigger = document.createElement('div')
    const popup = document.createElement('div')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 600, 80))
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(590, below ? 282 : 158, 110, 40))
    expect(claimHoverOwner(a, false, { trigger, popup })).toBe(true)
    expect(claimHoverOwner(b, false, undefined, { x: 650, y: below ? 300 : 180 })).toBe(false)
    // Same neighboring row, away from the path to the right-aligned popup: no timer is needed.
    expect(claimHoverOwner(b, false, undefined, { x: 110, y: below ? 300 : 180 })).toBe(true)
  })

  it.each([false, true])('hands over on another bubble outside the popup width without a close timer (below: %s)', (below) => {
    const trigger = document.createElement('div')
    const popup = document.createElement('div')
    const next = document.createElement('div')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 600, 80))
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(590, below ? 282 : 158, 110, 40))
    vi.spyOn(next, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, below ? 282 : 158, 600, 40))
    const point = { x: 450, y: below ? 290 : 190 }
    expect(claimHoverOwner(a, false, { trigger, popup })).toBe(true)
    expect(claimHoverOwner(b, false, { trigger: next, popup: null }, point)).toBe(true)
    releaseHoverOwner(b)
    expect(claimHoverOwner(a, false, { trigger, popup })).toBe(true)
    expect(claimHoverOwner(b, false, { trigger: next, popup: null }, { ...point, x: 650 })).toBe(false)
  })

  it.each([false, true])('distinguishes diagonal travel to the popup from entering another bubble vertically (below: %s)', (below) => {
    const trigger = document.createElement('div')
    const popup = document.createElement('div')
    const next = document.createElement('div')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 600, 80))
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(590, below ? 282 : 158, 110, 40))
    vi.spyOn(next, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, below ? 282 : 158, 600, 40))
    const point = { x: 550, y: below ? 290 : 190 }
    expect(claimHoverOwner(a, false, { trigger, popup }, { x: 400, y: 240 })).toBe(true)
    expect(claimHoverOwner(b, false, { trigger: next, popup: null }, point)).toBe(false)
    releaseHoverOwner(a)
    expect(claimHoverOwner(a, false, { trigger, popup }, { x: 550, y: 240 })).toBe(true)
    expect(claimHoverOwner(b, false, { trigger: next, popup: null }, point)).toBe(true)
  })

  it('uses the shifted left popup instead of assuming the popup is above the pointer', () => {
    const trigger = document.createElement('div')
    const popup = document.createElement('div')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 600, 80))
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 170, 110, 40))
    expect(claimHoverOwner(a, false, { trigger, popup })).toBe(true)
    expect(claimHoverOwner(b, false, undefined, { x: 140, y: 180 })).toBe(false)
    expect(claimHoverOwner(b, false, undefined, { x: 690, y: 180 })).toBe(true)
  })
})

describe('MessageHoverRegion renders at most one visible bar', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness()
  })
  afterEach(() => harness.cleanup())

  const Row = ({ name, forceOpen }: { name: string; forceOpen: boolean }) => (
    <MessageHoverRegion enabled forceOpen={forceOpen} style={{}} actions={<span data-bar={name} />}>{null}</MessageHoverRegion>
  )
  const bars = () => [...harness.container.querySelectorAll('[data-bar]')].map((node) => node.getAttribute('data-bar'))

  it.each([
    { side: 'left/down', originX: 150, x: 450, y: 290, popupX: 590, popupY: 282 },
    { side: 'right/up', originX: 650, x: 350, y: 190, popupX: 100, popupY: 158 },
  ])('uses the last position after horizontal travel before $side entry without notifying subscribers', async ({ originX, x, y, popupX, popupY }) => {
    await harness.render(<PreviewCard.Root><MessageHoverTrigger data-testid="owned-row">row</MessageHoverTrigger></PreviewCard.Root>)
    const trigger = harness.container.querySelector<HTMLElement>('[data-testid="owned-row"]')!
    const popup = document.createElement('div')
    const next = document.createElement('div')
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 600, 80))
    vi.spyOn(popup, 'getBoundingClientRect').mockReturnValue(new DOMRect(popupX, popupY, 110, 40))
    vi.spyOn(next, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, popupY, 600, 40))
    const a = Symbol('horizontal-owner'), b = Symbol('vertical-next')
    const notify = vi.fn()
    let off = () => {}
    try {
      expect(claimHoverOwner(a, false, { trigger, popup }, { x: originX, y: 240 })).toBe(true)
      const owner = readHoverOwner()
      off = subscribeHoverOwner(notify)
      await act(async () => { trigger.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 240 })) })
      expect.soft(readHoverOwner()?.point, 'the row records its latest pointer position').toEqual({ x, y: 240 })
      expect(readHoverOwner()).toBe(owner)
      expect(notify).not.toHaveBeenCalled()
      expect(claimHoverOwner(b, false, { trigger: next, popup: null }, { x, y }), 'vertical entry yields after horizontal travel on the old row').toBe(true)
    } finally {
      off()
      releaseHoverOwner(a)
      releaseHoverOwner(b)
    }
  })

  it('two rows asking to stay open (menus) show one bar, the first; it moves only when that menu closes', async () => {
    await harness.render(<><Row name="a" forceOpen /><Row name="b" forceOpen={false} /></>)
    expect(bars()).toEqual(['a'])
    await harness.render(<><Row name="a" forceOpen /><Row name="b" forceOpen /></>)
    expect(bars()).toEqual(['a'])
    await harness.render(<><Row name="a" forceOpen={false} /><Row name="b" forceOpen /></>)
    expect(bars()).toEqual(['b'])
    // And it settles: re-rendering the same tree does not keep handing the bar around.
    await harness.render(<><Row name="a" forceOpen={false} /><Row name="b" forceOpen /></>)
    expect(bars()).toEqual(['b'])
    await harness.render(<><Row name="a" forceOpen={false} /><Row name="b" forceOpen={false} /></>)
    expect(bars()).toEqual([])
  })
})
