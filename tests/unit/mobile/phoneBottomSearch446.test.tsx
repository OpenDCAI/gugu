// @vitest-environment jsdom
import { act, createRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HeaderSearch } from '../../../apps/desktop/src/components/ui/HeaderSearch'
import { PhoneTabBar } from '../../../apps/desktop/src/mobile/PhoneTabBar'
import type { PhoneViewport } from '../../../apps/desktop/src/mobile/usePhoneViewport'
import { clickElement, createReactHarness, typeInto } from '../../support/testHarness'

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); vi.stubGlobal('innerHeight', 844) })
afterEach(() => { h.cleanup(); vi.unstubAllGlobals() })
const normal: PhoneViewport = { viewportHeight: 844, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null }

function SearchPages() {
  const [tab, setTab] = useState<'chats' | 'contacts'>('chats')
  const [chats, setChats] = useState(''), [contacts, setContacts] = useState('')
  return <>
    <section hidden={tab !== 'chats'}><HeaderSearch mobile active={tab === 'chats'} externalTrigger="chats" value={chats} onChange={setChats} placeholder="搜索消息" testId="chats-search">{button => <header>{button}消息</header>}</HeaderSearch></section>
    <section hidden={tab !== 'contacts'}><HeaderSearch mobile active={tab === 'contacts'} externalTrigger="contacts" value={contacts} onChange={setContacts} placeholder="搜索伙伴" testId="contacts-search">{button => <header>{button}伙伴</header>}</HeaderSearch></section>
    <PhoneTabBar activeTab={tab} onTabChange={next => setTab(next as typeof tab)} pendingContactsCount={0} barRef={createRef()} tabs={['chats', 'contacts']} viewport={normal} />
  </>
}

it('bottom search opens and focuses only the current page, preserving the other query and refocusing on another tap', async () => {
  await h.render(<SearchPages />)
  expect(h.container.querySelector('[data-header-search-open]')).toBeNull()
  const search = h.container.querySelector<HTMLElement>('[data-testid="phone-list-search"]')!
  await clickElement(search)
  const messages = h.container.querySelector<HTMLInputElement>('[data-testid="chats-search"]')!
  expect(document.activeElement).toBe(messages)
  await typeInto(messages, 'old query')
  await clickElement(h.container.querySelector('[data-testid="mobile-contacts-nav"]')!)
  await clickElement(search)
  const contacts = h.container.querySelector<HTMLInputElement>('[data-testid="contacts-search"]')!
  expect(document.activeElement).toBe(contacts)
  await typeInto(contacts, 'project')
  expect(messages.value).toBe('old query')
  await act(async () => { contacts.blur() })
  await clickElement(search)
  expect(document.activeElement).toBe(contacts)
})

it('keeps the navigation anchor and DOM while focused or covered by the IME, then follows normal viewport changes', async () => {
  const ref = createRef<HTMLElement>()
  const render = (viewport: PhoneViewport) => h.render(<PhoneTabBar activeTab="contacts" onTabChange={vi.fn()} pendingContactsCount={2} barRef={ref} tabs={['chats', 'contacts']} viewport={viewport} />)
  await render(normal)
  const nav = ref.current!
  expect(nav.style.getPropertyValue('--phone-nav-selected-index')).toBe('1')
  vi.stubGlobal('innerHeight', 500)
  await render({ ...normal, inputFocused: true, keyboardVisible: true, viewportHeight: 500 })
  expect(ref.current).toBe(nav)
  expect(nav.style.getPropertyValue('--phone-nav-viewport-height')).toBe('844px')
  await render({ ...normal, inputFocused: true, keyboardVisible: false, viewportHeight: 500 })
  expect(nav.style.getPropertyValue('--phone-nav-viewport-height')).toBe('844px')
  await render({ ...normal, viewportHeight: 500 })
  expect(nav.style.getPropertyValue('--phone-nav-viewport-height')).toBe('500px')
})
