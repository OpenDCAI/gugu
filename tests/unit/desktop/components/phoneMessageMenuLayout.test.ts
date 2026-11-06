import { describe, expect, it } from 'vitest'
import { LIFT_SCALE, phoneMenuLayout } from '../../../../apps/desktop/src/components/chat/phoneMessageMenuLayout'

const viewport = { top: 0, width: 390, height: 844 }
const reactions = { width: 300, height: 48 }
const list = { width: 212, height: 300 }
const grow = (h: number) => h * (LIFT_SCALE - 1) / 2

describe('phone long-press layout', () => {
  it('lifts a short bubble in place when reactions and actions fit around it', () => {
    const bubble = { top: 300, left: 52, width: 200, height: 60 }
    const l = phoneMenuLayout({ bubble, touchY: 330, viewport, reactions, list, mine: false })
    expect(l.preview).toEqual(bubble)
    expect(l.clipTop).toBe(0)
    expect(l.reactions.top + reactions.height).toBeLessThanOrEqual(l.preview.top - grow(60))
    expect(l.list.top).toBeGreaterThanOrEqual(l.preview.top + 60 + grow(60))
  })
  it('slides a bubble near the bottom up just enough for the actions', () => {
    const l = phoneMenuLayout({ bubble: { top: 760, left: 52, width: 200, height: 60 }, touchY: 790, viewport, reactions, list, mine: false })
    expect(l.list.top + list.height).toBeLessThanOrEqual(844 - 8)
    expect(l.list.top + list.height).toBeGreaterThan(844 - 9)
  })
  it('shows only the part of a tall bubble around the finger, so the menu stays beside it', () => {
    const bubble = { top: -200, left: 52, width: 280, height: 2000 }
    const l = phoneMenuLayout({ bubble, touchY: 500, viewport, reactions, list, mine: false })
    expect(l.preview.height).toBeLessThan(844 - reactions.height - list.height)
    // The finger sits in the middle of the shown part.
    expect(bubble.top + l.clipTop + l.preview.height / 2).toBeCloseTo(500)
    expect(l.reactions.top).toBeGreaterThanOrEqual(8)
    expect(l.list.top + list.height).toBeLessThanOrEqual(836)
  })
  it('aligns to my bubble on the right and keeps the reactions inside the screen', () => {
    const bubble = { top: 300, left: 250, width: 130, height: 40 }
    const l = phoneMenuLayout({ bubble, touchY: 320, viewport, reactions, list, mine: true })
    expect(l.list.left + list.width).toBe(380)
    expect(l.reactions.left + reactions.width).toBe(380)
    const wide = phoneMenuLayout({ bubble: { top: 300, left: 40, width: 120, height: 40 }, touchY: 320, viewport, reactions: { width: 380, height: 48 }, list, mine: true })
    expect(wide.reactions.left, 'clamped into the screen').toBe(8)
  })
  it('keeps clear of the safe areas', () => {
    const l = phoneMenuLayout({ bubble: { top: 30, left: 52, width: 200, height: 40 }, touchY: 50, viewport: { top: 44, width: 390, height: 766 }, reactions, list, mine: false })
    expect(l.reactions.top).toBeGreaterThanOrEqual(44 + 8)
  })
})
