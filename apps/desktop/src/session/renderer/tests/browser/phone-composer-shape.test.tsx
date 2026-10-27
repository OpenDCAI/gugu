import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  root?.unmount()
  host?.remove()
  root = null
  host = null
})

// owner 10-28 手机试用:多打几行,输入框被 9999px 圆角压成了一个圆。
it('a multi-line phone composer grows into a rounded rectangle, not a circle', async () => {
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = 'width:370px'
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat />
    </LocalizationProvider>,
  )
  await until('the phone composer has mounted', () => !!host?.querySelector('[data-slot="composer"][data-mobile] [contenteditable]'))
  const box = host.querySelector<HTMLElement>('[data-slot="composer-input"]')!
  const radius = () => Number.parseFloat(getComputedStyle(box).borderTopLeftRadius)
  const oneLine = box.getBoundingClientRect().height
  expect(radius(), 'one line is still a capsule').toBeGreaterThanOrEqual(oneLine / 2 - 1)

  await page.getByTestId('chat-composer').fill('一\n二\n三\n四\n五')
  await until('five lines grow the composer', () => box.getBoundingClientRect().height > oneLine * 2)
  const { height, width } = box.getBoundingClientRect()
  expect(radius()).toBeLessThan(height / 4)
  expect(width, 'the box keeps its width while it grows').toBeGreaterThan(height)
})
