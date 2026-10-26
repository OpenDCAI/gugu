// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createReactHarness } from '../../support/testHarness'
import { MobileTabPager } from '../../../apps/desktop/src/mobile/MobileTabPager'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks() })
describe('mobile project navigation keeps its parent page', () => {
  it.each([false, true])('only a swipeable root can settle another root tab (swipeable=%s)', async (swipeable) => {
    HTMLElement.prototype.scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 390 } as DOMRect)
    const onSettle = vi.fn()
    await harness.render(createElement(MobileTabPager, { mobile: true, tabs: ['chats', 'contacts'], activeTab: 'contacts', swipeable,
      onSettle, tabBarRef: { current: null }, pages: { chats: 'messages', contacts: 'directory' },
    }))
    const pager = harness.container.querySelector('[data-mobile-tab-pager]') as HTMLDivElement
    // scrollIntoView / scroll-snap can report the old offset while a pushed page is returning.
    await act(async () => { pager.scrollLeft = 0; pager.dispatchEvent(new Event('scroll', { bubbles: true })) })
    if (swipeable) expect(onSettle).toHaveBeenCalledWith('chats')
    else expect(onSettle).not.toHaveBeenCalled()
  })
})
