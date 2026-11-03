import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer, MessageProvider, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null })

it('a running phone composer sends once and becomes Stop only after local commit', async () => {
  await page.viewport(390, 844)
  const api = createRef<PromptEditorRef>()
  let commit!: () => void
  const committed = new Promise<void>(resolve => { commit = resolve })
  const submit = vi.fn(() => { api.current!.clear(); return committed })
  const stop = vi.fn()
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;bottom:0;left:0;width:390px'
  root = createRoot(host)
  root.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}>
    <ChatComposer mobile isWorking editorApiRef={api} editorOptions={{ clearOnSubmit: false }} onSubmit={submit} onSubmitWhileWorking={submit} onStop={stop} />
  </MessageProvider></ThemeProvider>)
  await until('empty working composer shows Stop', () => !!host?.querySelector('[data-composer-action="stop"]'))
  await page.getByTestId('prompt-editor').fill('queued while working')
  const name = translateSessionMessage('composer.sendMessage')
  await page.getByRole('button', { name }).click()
  await until('one local submission started', () => submit.mock.calls.length === 1)
  expect(host.querySelector('[data-composer-action="stop"]')).toBeNull()
  const pending = host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
  expect(pending.disabled).toBe(true)
  pending.click(); pending.click()
  expect(submit).toHaveBeenCalledTimes(1)
  expect(stop).not.toHaveBeenCalled()
  commit()
  await until('local commit allows Stop', () => !!host?.querySelector('[data-composer-action="stop"]'))
  expect(stop).not.toHaveBeenCalled()
})
