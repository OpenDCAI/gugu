import { describe, expect, it } from 'vitest'
import { placeComposerPopup } from '../../../../apps/desktop/src/components/chat/composerPopupPlacement'

const base = {
  textareaOffset: { left: 48, top: 20 },
  scroll: { left: 0, top: 0 },
  containerWidth: 600,
  containerHeight: 62,
  popupWidth: 200,
}

describe('placeComposerPopup (2a)', () => {
  it('left-aligns the popup to the trigger character and sits it above that line', () => {
    expect(placeComposerPopup({ ...base, caret: { left: 120, top: 5 } })).toEqual({ left: 168, bottom: 62 - 25 + 6 })
  })

  it('an @ on the second line puts the popup above the second line, not the box top', () => {
    const first = placeComposerPopup({ ...base, caret: { left: 10, top: 5 } })
    const second = placeComposerPopup({ ...base, caret: { left: 10, top: 25 } })
    expect(first.bottom - second.bottom).toBe(20)
  })

  it('never runs past the right edge or left of the inset', () => {
    expect(placeComposerPopup({ ...base, caret: { left: 540, top: 5 } }).left).toBe(600 - 200 - 8)
    expect(placeComposerPopup({ ...base, textareaOffset: { left: 0, top: 20 }, caret: { left: 0, top: 5 } }).left).toBe(8)
  })

  it('subtracts the textarea scroll, and pins to the textarea top when the line scrolled out', () => {
    expect(placeComposerPopup({ ...base, caret: { left: 100, top: 65 }, scroll: { left: 0, top: 40 } }).bottom).toBe(62 - 45 + 6)
    expect(placeComposerPopup({ ...base, caret: { left: 100, top: 5 }, scroll: { left: 0, top: 40 } }).bottom).toBe(62 - 20 + 6)
  })
})
