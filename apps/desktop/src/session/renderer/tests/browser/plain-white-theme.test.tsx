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
  localStorage.removeItem('app-theme')
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themePreference
})

it.each([
  ['zh-CN', '主题', '素白'],
  ['en-US', 'Theme', 'Plain white'],
])('%s: General settings offers and selects the fourth appearance', async (locale, label, white) => {
  await i18n.changeLanguage(locale)
  await harness.render(<LocalizationProvider><ThemeProvider><GeneralSection onOpenPermissions={() => {}} /></ThemeProvider></LocalizationProvider>)
  const group = harness.container.querySelector(`[role="radiogroup"][aria-label="${label}"]`)!
  const options = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  expect(options).toHaveLength(4)
  const option = options.find((button) => button.textContent === white)!
  await act(async () => { await userEvent.click(option) })
  expect(option.getAttribute('aria-checked')).toBe('true')
  expect(options.filter((button) => button.getAttribute('aria-checked') === 'true')).toHaveLength(1)
  expect(localStorage.getItem('app-theme')).toBe('plain-white')
  expect(document.documentElement.dataset.theme).toBe('light')
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

it('replaces the gradient with pure white in every shared scope, using neutral glass', () => {
  writeThemePreference('plain-white')
  const { shell, phone, desktop, panel, menu } = surfaces()
  for (const surface of [shell, phone, desktop, panel]) {
    const style = getComputedStyle(surface)
    expect(style.backgroundImage).toBe('none')
    expect(style.backgroundColor).toBe('rgb(255, 255, 255)')
  }
  for (const scope of [shell, phone, desktop, menu]) {
    const style = getComputedStyle(scope)
    expect(style.getPropertyValue('--ta-panel-bg').trim()).toBe(style.getPropertyValue('--bg').trim())
    expect(style.getPropertyValue('--ta-glass').trim()).toBe(style.getPropertyValue('--card').trim())
    expect(style.getPropertyValue('--ta-tint-ink').trim()).toBe(style.getPropertyValue('--fg').trim())
  }
})

it.each(['phone group', 'phone assistant', 'desktop assistant'])(
  '%s: received bubbles remain distinct from the plain white page', (place) => {
    writeThemePreference('plain-white')
    const { shell, phone, panel } = surfaces()
    const surface = place === 'phone group' ? shell : place === 'phone assistant' ? phone : panel
    const chat = document.createElement('div')
    if (place !== 'phone group') chat.className = 'ta-chat'
    const bubble = document.createElement('div')
    bubble.textContent = 'Keyboard-assistant-check received.'
    Object.assign(bubble.style, buildBubbleStyle(false, false, place !== 'desktop assistant'))
    const messageList = document.createElement('div')
    messageList.appendChild(bubble)
    chat.appendChild(messageList)
    surface.appendChild(chat)

    const background = getComputedStyle(bubble).backgroundColor
    expect(background).not.toBe('rgba(0, 0, 0, 0)')
    expect(background).not.toBe(getComputedStyle(surface).backgroundColor)
  },
)

it('keeps the default gradient and dark gradient, including switching away from white', async () => {
  const { shell, panel } = surfaces()
  expect(localStorage.getItem('app-theme')).toBeNull()
  for (const surface of [shell, panel]) {
    expect(getComputedStyle(surface).backgroundImage).toContain('rgb(169, 201, 234)')
  }
  await act(async () => { writeThemePreference('plain-white') })
  await act(async () => { writeThemePreference('dark') })
  for (const surface of [shell, panel]) {
    expect(getComputedStyle(surface).backgroundImage).toContain('rgb(31, 44, 61)')
  }
  await act(async () => { writeThemePreference('light') })
  for (const surface of [shell, panel]) {
    expect(getComputedStyle(surface).backgroundImage).toContain('rgb(169, 201, 234)')
  }
})
