import { afterEach, beforeEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { MobileTabPager } from '@/mobile/MobileTabPager'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await page.viewport(390, 844)
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  delete document.documentElement.dataset.theme
})

it.each(['light', 'dark'])('%s: only phone root-list headers get separate layers, without moving them', async (theme) => {
  document.documentElement.dataset.theme = theme
  const rootList = (tab: 'chats' | 'contacts') => (
    <Pane paneRole="nav" mobile data-phone-root-list={tab}>
      <div><PaneHeader mobile titleLevel="page" title={tab} /></div>
    </Pane>
  )
  await harness.render(<>
    <div data-phone-shell="" style={{ display: 'flex', height: 400, width: 390 }}>
      <MobileTabPager mobile tabs={['chats', 'contacts']} activeTab="chats" swipeable
        onSettle={() => {}} tabBarRef={{ current: null }} pages={{ chats: rootList('chats'), contacts: rootList('contacts') }} />
    </div>
    <div data-phone-shell="">
      {['private chat', 'group chat', 'settings'].map(title => (
        <Pane key={title} paneRole="detail" mobile><PaneHeader mobile title={title} /></Pane>
      ))}
    </div>
    <Pane paneRole="nav"><PaneHeader title="desktop" /></Pane>
  </>)
  const roots = [...harness.container.querySelectorAll<HTMLElement>('[data-phone-root-list] .gg-pane-header')]
  expect(roots).toHaveLength(2)
  for (const header of roots) {
    expect(getComputedStyle(header).transform).not.toBe('none')
    const rect = header.getBoundingClientRect().toJSON()
    header.style.transform = 'none'
    expect(header.getBoundingClientRect().toJSON()).toEqual(rect)
    header.style.removeProperty('transform')
  }
  const others = [...harness.container.querySelectorAll<HTMLElement>('.gg-pane-header')].filter(header => !roots.includes(header))
  expect(others).toHaveLength(4)
  for (const header of others) expect(getComputedStyle(header).transform).toBe('none')
})
