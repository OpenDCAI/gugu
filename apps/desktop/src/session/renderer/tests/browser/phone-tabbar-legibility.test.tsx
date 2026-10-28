/**
 * owner 10-28 手机试用:底部菜单没选中的那格看不清,图标和字没上下居中,切换时一点动静都没有。
 * 真 Chromium、真 tokens / 咕咕页渐变 / 手机壳样式,挂产品同一个 PhoneTabBar,390 宽。
 */
import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { LocalizationProvider, getLocaleSnapshot, setLocalePreference } from '@/i18n'
import { PhoneTabBar } from '@/mobile/PhoneTabBar'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/session/renderer/features/assistant/assistant-today.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

let root: Root | null = null
const previousLocale = getLocaleSnapshot().preference
afterEach(() => {
  setLocalePreference(previousLocale)
  root?.unmount()
  root = null
  document.documentElement.removeAttribute('data-theme')
  document.body.replaceChildren()
})

const VIEWPORT = { viewportHeight: 844, viewportOffsetTop: 0, inputFocused: false, keyboardVisible: null }
const TABS = ['chats', 'contacts'] as const

async function mountBar(theme: 'dark' | 'light', activeTab: (typeof TABS)[number] = 'chats') {
  await page.viewport(390, 844)
  setLocalePreference('zh-CN')
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light')
  const shell = document.body.appendChild(document.createElement('div'))
  shell.setAttribute('data-phone-shell', '')
  shell.setAttribute('data-ta-scope', '')
  shell.style.cssText = 'position:fixed;inset:0;background:var(--ta-app-bg)'
  root = createRoot(shell)
  const barRef = createRef<HTMLElement>()
  const render = (tab: (typeof TABS)[number]): void => root!.render(
    <LocalizationProvider>
      <PhoneTabBar activeTab={tab} onTabChange={(next) => render(next as (typeof TABS)[number])} pendingContactsCount={0} barRef={barRef} tabs={TABS} viewport={VIEWPORT} />
    </LocalizationProvider>,
  )
  render(activeTab)
  await until('the tab bar has mounted', () => document.querySelectorAll('.gg-phone-nav-item').length === 2)
  return { shell, render, barRef, items: [...document.querySelectorAll<HTMLElement>('.gg-phone-nav-item')] }
}

function rgb(css: string): number[] {
  const srgb = css.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/)
  if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])]
  const m = css.match(/rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)/)
  if (!m) throw new Error(`unparsed color: ${css}`)
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
}
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** 玻璃底在页底渐变上的实际颜色:把栏的半透明白按 alpha 叠到渐变末端色上(玻璃模糊的就是那一段)。 */
function glassOver(bar: HTMLElement, pageBottom: readonly number[]): number[] {
  const css = getComputedStyle(bar).backgroundColor
  const alpha = Number(css.match(/[\d.]+(?=\))/)?.[0] ?? 1)
  const glass = rgb(css)
  return glass.map((g, i) => g * alpha + pageBottom[i]! * (1 - alpha))
}

it.each([
  ['dark', [0x1b / 255, 0x19 / 255, 0x16 / 255]],
  ['light', [0xec / 255, 0xeb / 255, 0xe8 / 255]],
] as const)('%s: the unselected tab reads at 4.5:1 or better on the glass', async (theme, pageBottom) => {
  const { items } = await mountBar(theme)
  const bar = document.querySelector<HTMLElement>('.gg-phone-nav-destinations')!
  const idle = rgb(getComputedStyle(items[1]!).color)
  expect(contrast(idle, glassOver(bar, pageBottom))).toBeGreaterThanOrEqual(4.5)
})

// owner 10-28 真机:浅色米色底上,选中「伙伴」那颗胶囊淡得看不出来。
it.each([
  ['dark', [0x1b / 255, 0x19 / 255, 0x16 / 255]],
  ['light', [0xec / 255, 0xeb / 255, 0xe8 / 255]],
] as const)('%s: the selected capsule stands apart from the glass', async (theme, pageBottom) => {
  await mountBar(theme, 'contacts')
  const bar = document.querySelector<HTMLElement>('.gg-phone-nav-destinations')!
  const glass = glassOver(bar, pageBottom)
  const pillCss = getComputedStyle(bar, '::before').backgroundColor
  const alpha = Number(pillCss.match(/\/ ([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\)/)?.slice(1).find(Boolean) ?? 1)
  const pill = rgb(pillCss).map((c, i) => c * alpha + glass[i]! * (1 - alpha))
  expect(contrast(pill, glass)).toBeGreaterThanOrEqual(1.15)
  await page.screenshot({ path: `phone-tabbar-${theme}-partners.png` })
})

it('icon and label sit in the vertical middle of each tab', async () => {
  const { items } = await mountBar('dark')
  for (const item of items) {
    const box = item.getBoundingClientRect()
    const icon = item.querySelector<HTMLElement>('.gg-phone-nav-icon')!.getBoundingClientRect()
    const label = item.querySelector<HTMLElement>(':scope > span:last-child')!.getBoundingClientRect()
    const above = icon.top - box.top
    const below = box.bottom - label.bottom
    expect(Math.abs(above - below), `top ${above} / bottom ${below}`).toBeLessThanOrEqual(1)
  }
  await page.screenshot({ path: 'phone-tabbar-chats.png' })
})

it('tapping a tab slides the selection over a short transition, never while swiping, and not under reduced motion', async () => {
  const { barRef, items } = await mountBar('dark')
  const pill = () => getComputedStyle(document.querySelector('.gg-phone-nav-destinations')!, '::before')
  expect(Number.parseFloat(pill().transitionDuration), 'a swipe writes the position every frame: no transition to lag the finger').toBe(0)
  items[1]!.click()
  await until('the second tab is current', () => items[1]!.getAttribute('aria-current') === 'page')
  expect(barRef.current!.hasAttribute('data-tab-switching')).toBe(true)
  expect(pill().transitionProperty).toContain('transform')
  expect(Number.parseFloat(pill().transitionDuration)).toBeGreaterThan(0)
  expect(getComputedStyle(items[1]!).transitionProperty).toContain('color')
  await until('the transition window closes', () => !barRef.current!.hasAttribute('data-tab-switching'))
  await page.screenshot({ path: 'phone-tabbar-contacts.png' })

  const motionRules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules])
    .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule && [...rule.cssRules].some((inner) => inner.cssText.includes('data-tab-switching')))
  expect(motionRules.length).toBeGreaterThan(0)
  for (const rule of motionRules) expect(rule.conditionText).toContain('prefers-reduced-motion: no-preference')
})

it('light theme screenshot', async () => {
  await mountBar('light')
  await page.screenshot({ path: 'phone-tabbar-chats-light.png' })
})
