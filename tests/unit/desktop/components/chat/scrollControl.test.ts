import { describe, expect, it } from 'vitest'
import { classifyFeedChange, type FeedItem, type FeedTrack } from '../../../../../apps/desktop/src/components/chat/scrollControl'
// #1315 — IM-scroll semantics (WeChat/Feishu). These pin the decision logic that drives the list's
// imperative scroll: at-bottom snaps to true bottom for BOTH sent and received; scrolled-up received
// does not yank (the unread bubble is the history window's count).
const m = (id: string, mine = false): FeedItem => ({ id, is_mine: mine })
describe('classifyFeedChange', () => {
  it('empty feed → no action', () => {
    expect(classifyFeedChange({ firstId: null, lastId: null }, [], true)).toEqual({ pin: false })
  })
  describe('back-grow (a new newest message)', () => {
    const prev: FeedTrack = { firstId: 'a', lastId: 'b' }
    const feed = [m('a'), m('b'), m('c')] // 'c' is the new newest
    it.each([
      ['at bottom received', prev, feed, true, true],
      ['scrolled-up received', prev, feed, false, false],
      ['own message', prev, [m('a'), m('b'), m('c', true)], false, true],
      ['multiple received', prev, [m('a'), m('b'), m('c'), m('d')], false, false],
      ['first newest message', { firstId: null, lastId: null }, [m('x')], false, false],
      ['no new newest message', { firstId: 'a', lastId: 'c' }, feed, false, false],
      ['older page prepended, nothing appended', { firstId: 'c', lastId: 'c' }, [m('a'), m('b'), m('c')], true, false],
      ['older page prepended and a new newest', { firstId: 'b', lastId: 'c' }, [m('a'), m('b'), m('c'), m('d')], true, true],
    ])('%s applies the expected back-grow decision', (_label, before, next, atBottom, pin) => {
      const r = classifyFeedChange(before, next, atBottom)
      expect(r.pin).toBe(pin)
    })
  })
})
