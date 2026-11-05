import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { LocalizationProvider } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import '@/mobile/phone-shell.css'
import '@/mobile/phone-look.css'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null })

it.each(['pointer', 'programmatic'] as const)('390px phone composer dismisses focus after a %s send, while Enter keeps editing', async (method) => {
  await page.viewport(390, 844)
  const onSend = vi.fn(async () => {})
  host = document.body.appendChild(document.createElement('div'))
  host.setAttribute('data-phone-shell', '')
  host.style.cssText = 'position:fixed;bottom:0;left:0;width:390px'
  root = createRoot(host)
  root.render(<LocalizationProvider><ChatMessageComposer onSend={onSend} /></LocalizationProvider>)
  await until('phone composer mounted', () => !!host?.querySelector('[data-slot="composer"][data-mobile] [contenteditable]'))
  const editor = host.querySelector<HTMLElement>('[contenteditable]')!
  await page.getByTestId('chat-composer').fill('Phone keyboard check')
  await userEvent.keyboard('{Enter}')
  expect(onSend).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(editor)
  const blurred = vi.fn()
  const focused = vi.fn()
  editor.addEventListener('blur', blurred)
  editor.addEventListener('focus', focused)
  const button = page.getByRole('button', { name: translateSessionMessage('composer.sendMessage') })
  if (method === 'pointer') await button.click()
  else host.querySelector<HTMLButtonElement>(`button[aria-label="${translateSessionMessage('composer.sendMessage')}"]`)!.click()
  await until('send reached chat host', () => onSend.mock.calls.length === 1)
  expect(blurred).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(document.body)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  expect(document.activeElement).toBe(document.body)
  expect(focused).not.toHaveBeenCalled()
  expect(editor.textContent).toBe('')
})

it('desktop pointer sends retain the native button-focus behavior', async () => {
  await page.viewport(1000, 844)
  const submit = vi.fn()
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  root.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}>
    <ChatComposer onSubmit={submit} />
  </MessageProvider></ThemeProvider>)
  await until('desktop editor mounted', () => !!host?.querySelector('[contenteditable]'))
  await page.getByTestId('prompt-editor').fill('Desktop focus check')
  const name = translateSessionMessage('composer.sendMessage')
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  await page.getByRole('button', { name }).click()
  expect(submit).toHaveBeenCalledExactlyOnceWith('Desktop focus check')
  expect(document.activeElement).toBe(button)
})
