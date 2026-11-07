// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { readMobileListGeometry } from '../../../apps/desktop/src/mobile/useMobileListDiagnostics'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
it('reads missing/hidden root and off-page pager facts without reading user content', () => {
  document.body.innerHTML = `<main><div data-mobile-tab-pager style="display:flex"><section data-mobile-tab-page="chats" inert>
    <div data-testid="chat-list-pane" style="display:none"><nav data-phone-root-list="chats">
      <button data-testid="mobile-profile-nav">private-email</button><div>private-title</div>
    </nav></div></section></div></main>`
  const root = document.querySelector('main')!
  const pager = root.querySelector('[data-mobile-tab-pager]')!
  Object.defineProperty(pager, 'scrollLeft', { value: 180 })
  Object.defineProperty(pager, 'scrollWidth', { value: 720 })
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 360, height: 766 } as DOMRect)
  const sampled = readMobileListGeometry(root)
  expect(sampled).toMatchObject({ shell: { width: 360, height: 766 }, listPane: { display: 'none', inert: true },
    list: { inert: true }, scrollLeft: 180, scrollWidth: 720 })
  expect(JSON.stringify(sampled)).not.toMatch(/private-email|private-title/)
  root.replaceChildren()
  expect(readMobileListGeometry(root)).toMatchObject({ listPane: null, list: null, me: null, pager: null, scrollLeft: null })
})
