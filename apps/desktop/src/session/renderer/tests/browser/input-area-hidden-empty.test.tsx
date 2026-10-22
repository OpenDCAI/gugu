import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { InputArea } from '@/components/chat/InputArea'
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
      <InputArea onSend={vi.fn(async () => {})} isGroupChat hidden={hidden} />
    </LocalizationProvider>,
  )
  render(true)
  // The same visibility signal as the mobile chat detail.
  await until('the hidden composer has mounted', () => !!host?.querySelector('textarea'))
  const textarea = host.querySelector('textarea')!
  expect(textarea.scrollHeight, 'positive control: hidden layout has no height').toBe(0)
  expect(textarea.getBoundingClientRect().height).toBe(0)

  host.style.display = 'block'
  render(false)
  await until('showing measures the real placeholder', () => textarea.style.height !== '' && textarea.scrollHeight <= textarea.clientHeight)
  const style = getComputedStyle(textarea)
  const oneLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  expect(oneLine).toBeGreaterThan(0)
  expect(textarea.placeholder).toBe(i18n.t('composer.placeholder', { ns: 'messaging' }))
  expect(textarea.value).toBe('')
  expect(textarea.getBoundingClientRect().height).toBeGreaterThanOrEqual(oneLine)
  expect(textarea.scrollHeight).toBeLessThanOrEqual(textarea.clientHeight)

  const input = page.getByRole('textbox')
  await input.fill('First line\nSecond line\nThird line')
  await until('visible text expands the composer', () => textarea.getBoundingClientRect().height > oneLine)
  expect(textarea.value).toContain('Third line')

  host.style.display = 'none'
  render(true)
  await until('the multiline draft is hidden', () => textarea.scrollHeight === 0)
  host.style.display = 'block'
  render(false)
  await until('showing restores the multiline draft height', () => textarea.scrollHeight <= textarea.clientHeight)
  expect(textarea.getBoundingClientRect().height).toBeGreaterThan(oneLine)
  expect(textarea.value).toContain('Third line')

  await input.fill(Array.from({ length: 20 }, (_, index) => `Line ${index}`).join('\n'))
  await until('long text reaches the existing height cap', () => textarea.getBoundingClientRect().height === 110)
  expect(textarea.scrollHeight).toBeGreaterThan(textarea.clientHeight)

  await input.fill('')
  await until('clearing fits the real placeholder', () => textarea.value === '' && textarea.scrollHeight <= textarea.clientHeight)
  expect(textarea.getBoundingClientRect().height).toBeGreaterThanOrEqual(oneLine)
  expect(host.querySelector('textarea')).toBe(textarea)
})
