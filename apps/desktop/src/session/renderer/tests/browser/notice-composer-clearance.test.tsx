import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { NoticeHost } from '@/components/NoticeHost'
import { dismissNotice, notify } from '@/lib/notices'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'

let harness: ReturnType<typeof createReactHarness>
afterEach(() => { dismissNotice('clearance'); harness?.cleanup() })
const card = () => document.querySelector<HTMLElement>('[data-sonner-toast]')!
const composer = () => document.querySelector<HTMLElement>('[data-testid="visible-composer"]')!
const gap = () => composer().getBoundingClientRect().top - card().getBoundingClientRect().bottom
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Exercise real Sonner positioning and hit testing, rather than asserting a calculated offset.
function Layout({ height = 120, split = false, filePane = false, hidden = false }: { height?: number; split?: boolean; filePane?: boolean; hidden?: boolean }) {
  return <><NoticeHost />
    <div style={{ position: 'fixed', left: 200, right: filePane ? 240 : 20, bottom: 20, display: hidden ? 'none' : 'flex', gap: 12 }}>
      {split && <div data-slot="composer" style={{ width: '40%', height: height + 50, background: 'white' }}><textarea aria-label="Topic message" /></div>}
      <div data-slot="composer" data-testid="visible-composer" style={{ flex: 1, height, background: 'white', position: 'relative' }}>
        <textarea aria-label="Message" style={{ width: '100%', height: '100%' }} /><button data-testid="send" style={{ position: 'absolute', right: 4, bottom: 4 }}>Send</button>
      </div>
    </div>
    <div style={{ position: 'fixed', inset: 0, contentVisibility: 'hidden', pointerEvents: 'none' }}>
      <div data-slot="composer" style={{ position: 'absolute', top: 10, width: 400, height: 500 }} />
    </div>
  </>
}

it('keeps the real notice stack above visible composers as they grow, split, resize and disappear', async () => {
  await page.viewport(1200, 800)
  harness = createReactHarness()
  await harness.render(<Layout />)
  await act(async () => { notify({ key: 'clearance', title: 'Please retry this operation.', tier: 'error', ongoing: true, action: { label: 'Retry', onClick() {} } }) })
  await until('notice subscribes', () => !!card())
  // Upstream enter/exit/swipe animations cross the origin even when the settled
  // card is correctly positioned. Its clipped area must not intercept input.
  const assertInputClear = async () => {
    for (let frame = 0; frame < 30; frame++) {
      const box = composer().getBoundingClientRect()
      const hit = document.elementFromPoint(box.right - 60, box.top + 5)
      expect(card()?.contains(hit)).not.toBe(true)
      await new Promise(requestAnimationFrame)
    }
  }
  await assertInputClear()
  await until('notice is 8px above the composer', () => !!card() && Math.abs(gap() - 8) < 1)
  const originalRight = window.innerWidth - card().getBoundingClientRect().right
  const send = document.querySelector<HTMLElement>('[data-testid="send"]')!
  const sendRect = send.getBoundingClientRect()
  expect(document.elementFromPoint(sendRect.x + sendRect.width / 2, sendRect.y + sendRect.height / 2)).toBe(send)

  await harness.render(<Layout height={240} />)
  await until('composer growth moves the notice', () => Math.abs(gap() - 8) < 1)
  await harness.render(<Layout height={180} split filePane />)
  await page.viewport(900, 650)
  await until('both split composers are clear', () => [...document.querySelectorAll<HTMLElement>('[data-slot="composer"]')].filter((element) => element.checkVisibility()).every((element) => card().getBoundingClientRect().bottom <= element.getBoundingClientRect().top - 8))
  expect(window.innerWidth - card().getBoundingClientRect().right).toBeCloseTo(originalRight, 0)

  await act(async () => dismissNotice('clearance'))
  await assertInputClear()
  await act(async () => { notify({ key: 'clearance', title: 'Please retry this operation.', tier: 'error', ongoing: true }) })
  await until('new notice appears above the split', () => !!card() && Math.abs(gap() - 8) < 1)

  await harness.render(<Layout hidden />)
  await until('a page without a composer restores the ordinary bottom inset', () => window.innerHeight - card().getBoundingClientRect().bottom < 50)
  // Let any delayed observer callbacks run after the owner is removed: they must be disconnected.
  await harness.render(<></>)
  await sleep(30)
  expect(document.querySelector('[data-sonner-toaster]')).toBeNull()
})
