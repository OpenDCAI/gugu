import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { GeneralSection } from '@/components/settings/GeneralSection'
import { buildBubbleStyle } from '@/components/chat/messageBubbleStyle'
import { i18n, LocalizationProvider } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { hydrateHostTheme, writeThemePreference } from '@/session/renderer/lib/theme/host-theme'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@/session/renderer/features/assistant/assistant-today.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'
import '@/mobile/assistant/assistant-phone.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key',
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await page.viewport(390, 844)
  localStorage.removeItem('app-theme')
  hydrateHostTheme()
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
  localStorage.removeItem('app-theme')
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themePreference
})

it.each([
  ['zh-CN', '主题', 390],
  ['zh-CN', '主题', 1280],
  ['en-US', 'Theme', 390],
  ['en-US', 'Theme', 1280],
] as const)('%s settings (%s, %spx): offers only light, dark and system', async (locale, label, width) => {
  await page.viewport(width, 844)
  await i18n.changeLanguage(locale)
  await harness.render(<LocalizationProvider><ThemeProvider><GeneralSection onOpenPermissions={() => {}} /></ThemeProvider></LocalizationProvider>)
  const group = harness.container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!
  const options = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const preferences = ['light', 'dark', 'system'] as const
  const labels = locale === 'zh-CN' ? ['浅色', '深色', '跟随系统'] : ['Light', 'Dark', 'System']
  expect(options.map(button => button.textContent)).toEqual(labels)
  for (const [index, preference] of preferences.entries()) {
    await act(async () => { await userEvent.click(options[index]!) })
    expect(options[index]!.getAttribute('aria-checked')).toBe('true')
    expect(options.filter(button => button.getAttribute('aria-checked') === 'true')).toHaveLength(1)
    expect(localStorage.getItem('app-theme')).toBe(preference)
  }
})

function surfaces() {
  const shell = document.createElement('div')
  shell.setAttribute('data-phone-shell', '')
  shell.setAttribute('data-ta-scope', '')
  // MainLayout paints this background inline; the shell stylesheet only supplies geometry.
  shell.style.background = 'var(--ta-panel-bg)'
  const phone = document.createElement('div')
  phone.className = 'ta-phone'
  shell.appendChild(phone)
  const desktop = document.createElement('div')
  desktop.className = 'ta-app'
  const panel = document.createElement('div')
  panel.className = 'ta-panel'
  desktop.appendChild(panel)
  const menu = document.createElement('div')
  menu.setAttribute('data-ta-menu', '')
  harness.container.append(shell, desktop, menu)
  return { shell, phone, desktop, panel, menu }
}

function referenceBackground(background: string) {
  const reference = document.createElement('div')
  reference.style.background = background
  harness.container.appendChild(reference)
  const style = getComputedStyle(reference)
  return { image: style.backgroundImage, color: style.backgroundColor }
}

const appearances = [
  ['light', false, 'light'],
  ['dark', true, 'dark'],
  ['system', false, 'light'],
  ['system', true, 'dark'],
] as const

function setAppearance(preference: 'light' | 'dark' | 'system', dark: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: dark })))
  writeThemePreference(preference)
}

it.each(appearances)('%s with system dark=%s: phone surfaces use the neutral %s background', (preference, dark) => {
  setAppearance(preference, dark)
  const { shell, phone } = surfaces()
  const neutral = referenceBackground('var(--bg)')
  for (const surface of [shell, phone]) {
    const style = getComputedStyle(surface)
    expect(style.backgroundImage).toBe('none')
    expect(style.backgroundColor).toBe(neutral.color)
    expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  }
})

it.each(['phone group', 'phone assistant'])(
  '%s: received bubbles use the existing light gray fill', (place) => {
    writeThemePreference('light')
    const { shell, phone } = surfaces()
    const surface = place === 'phone group' ? shell : phone
    const chat = document.createElement('div')
    if (place !== 'phone group') chat.className = 'ta-chat'
    const bubble = document.createElement('div')
    bubble.textContent = 'Keyboard-assistant-check received.'
    Object.assign(bubble.style, buildBubbleStyle(false, false, true))
    const messageList = document.createElement('div')
    messageList.appendChild(bubble)
    chat.appendChild(messageList)
    surface.appendChild(chat)

    const background = getComputedStyle(bubble).backgroundColor
    expect(background).toBe(referenceBackground('var(--muted)').color)
    expect(background).not.toBe('rgba(0, 0, 0, 0)')
    expect(background).not.toBe(referenceBackground('var(--bg)').color)
  },
)

// Fixed existing desktop palettes, independent of the stylesheet under test.
const desktopBaseline = {
  light: {
    app: 'linear-gradient(180deg, #dfe6ec 0%, #e5e8ec 55%, #ecebe8 100%)',
    panel: 'linear-gradient(180deg, #a9c9ea 0%, #c5d8ef 30%, #e2e5f3 60%, #f4e6dc 80%, #fcd9b5 100%)',
  },
  dark: {
    app: 'linear-gradient(180deg, #14171c 0%, #17181b 60%, #1b1916 100%)',
    panel: 'linear-gradient(180deg, #1f2c3d 0%, #23283a 45%, #2a2531 70%, #33271f 100%)',
  },
}

it.each(appearances)('%s with system dark=%s: desktop retains the existing %s appearance', (preference, dark, effective) => {
  setAppearance(preference, dark)
  const { desktop, panel } = surfaces()
  expect(getComputedStyle(desktop).backgroundImage).toBe(referenceBackground(desktopBaseline[effective].app).image)
  expect(getComputedStyle(panel).backgroundImage).toBe(referenceBackground(desktopBaseline[effective].panel).image)
})
