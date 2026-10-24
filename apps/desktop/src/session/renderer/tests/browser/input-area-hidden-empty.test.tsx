import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider, i18n, getLocaleSnapshot, setLocalePreference } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

let previousLocale = getLocaleSnapshot().preference
let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => { previousLocale = getLocaleSnapshot().preference })

afterEach(() => {
  root?.unmount()
  host?.remove()
  root = null
  host = null
  setLocalePreference(previousLocale)
})

it.each(['en-US', 'zh-CN'] as const)('a hidden empty group composer shows its real %s placeholder without typing, then grows and clears', async (locale) => {
  setLocalePreference(locale)
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'display:none;width:370px'
  root = createRoot(host)
  const render = (hidden: boolean) => root!.render(
    <LocalizationProvider>
      <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat hidden={hidden} />
    </LocalizationProvider>,
  )
  render(true)
  await until('the hidden composer has mounted', () => !!host?.querySelector('[contenteditable]'))
  const editor = host.querySelector<HTMLElement>('[contenteditable]')!
  const scroller = editor.closest<HTMLElement>('[data-slot="composer-input"]')!
  expect(editor.getBoundingClientRect().height, 'positive control: hidden layout has no height').toBe(0)

  host.style.display = 'block'
  render(false)
  await until('showing lays out the shared editor', () => scroller.clientHeight > 0)
  const oneLine = editor.getBoundingClientRect().height
  expect(oneLine).toBeGreaterThan(0)
  expect(editor.getAttribute('data-placeholder')).toBe(i18n.t('composer.placeholder', { ns: 'messaging' }))
  expect(editor.innerText.trim()).toBe('')
  expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight)

  const input = page.getByTestId('chat-composer')
  await input.fill('First line\nSecond line\nThird line')
  await until('visible text expands the composer', () => editor.getBoundingClientRect().height > oneLine)
  expect(editor.innerText).toContain('Third line')

  host.style.display = 'none'
  render(true)
  await until('the multiline draft is hidden', () => editor.getBoundingClientRect().height === 0)
  host.style.display = 'block'
  render(false)
  await until('showing restores the multiline draft', () => editor.getBoundingClientRect().height > oneLine)
  expect(editor.innerText).toContain('Third line')

  await input.fill(Array.from({ length: 20 }, (_, index) => `Line ${index}`).join('\n'))
  await until('long text reaches the shared height cap', () => scroller.scrollHeight > scroller.clientHeight)
  expect(scroller.clientHeight).toBe(Number.parseFloat(getComputedStyle(scroller).maxHeight))

  await input.fill('')
  await until('clearing fits the real placeholder', () => editor.innerText.trim() === '' && scroller.scrollHeight <= scroller.clientHeight)
  expect(editor.getBoundingClientRect().height).toBe(oneLine)
  expect(host.querySelector('[contenteditable]')).toBe(editor)
})
