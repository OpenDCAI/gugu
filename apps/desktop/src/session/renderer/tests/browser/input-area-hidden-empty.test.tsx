import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider, i18n, getLocaleSnapshot, setLocalePreference } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'

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
  expect(editor.getAttribute('data-placeholder')).toBe(i18n.t('composer.mobilePlaceholder', { ns: 'messaging' }))
  expect(editor.innerText.trim()).toBe('')
  expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight)
  const card = host.querySelector<HTMLElement>('[data-slot="composer-bar"]')!
  const attach = host.querySelector<HTMLElement>('[data-slot="composer-actions-start"] button')!
  const send = host.querySelector<HTMLElement>('[data-slot="composer-actions-end"] button')!
  expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(60)
  for (const control of [attach, send]) {
    expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44)
    expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44)
  }
  expect(attach.getBoundingClientRect().top).toBe(send.getBoundingClientRect().top)
  expect(attach.getBoundingClientRect().right).toBeLessThanOrEqual(editor.getBoundingClientRect().left)
  expect(editor.getBoundingClientRect().right).toBeLessThanOrEqual(send.getBoundingClientRect().left)

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

  // fill('') selects a DOM range and sends Delete in separate commands; the editor can restore its old caret between them.
  // Select through the editor keymap so the deletion sees an AllSelection in both the model and DOM.
  await input.click()
  const modifier = /Mac/.test(navigator.platform) ? 'Meta' : 'Control'
  await userEvent.keyboard(`{${modifier}>}a{/${modifier}}{Backspace}`)
  await until('clearing fits the real placeholder', () => editor.innerText.trim() === '' && scroller.scrollHeight <= scroller.clientHeight)
  expect(editor.getBoundingClientRect().height).toBe(oneLine)
  expect(host.querySelector('[contenteditable]')).toBe(editor)

  await page.viewport(1280, 900)
  await until('wide web uses the desktop composer', () => !host!.querySelector('[data-mobile-group]'))
  expect(editor.getAttribute('data-placeholder')).toBe(i18n.t('composer.placeholder', { ns: 'messaging' }))
  expect(send.getBoundingClientRect().top).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().bottom)
})
