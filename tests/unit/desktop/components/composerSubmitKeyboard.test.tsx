// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { createReactHarness } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

let harness: ReturnType<typeof createReactHarness>
const editor = () => harness.container.querySelector<HTMLElement>('[contenteditable="true"]')!
const send = () => harness.container.querySelector<HTMLButtonElement>(`button[aria-label="${translateSessionMessage('composer.sendMessage')}"]`)!
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function render(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onSubmit = vi.fn()
  await harness.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}><ChatComposer mobile onSubmit={onSubmit} {...props} /></MessageProvider></ThemeProvider>)
  return onSubmit
}

describe('shared composer submission focus', () => {
  it.each(['button', 'focused button', 'attachment'] as const)('dismisses phone focus for an accepted %s send', async (method) => {
    const onSubmit = await render(method === 'attachment' ? { attachments: [{ id: 'file', name: 'notes.txt', kind: 'file' }] } : {})
    await act(async () => {
      if (method !== 'attachment') writeComposer(editor(), 'hello')
      editor().focus()
    })
    expect(document.activeElement).toBe(editor())
    await act(async () => {
      if (method === 'focused button') send().focus()
      send().click()
    })
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(method === 'attachment' ? '' : 'hello')
    expect(document.activeElement).toBe(document.body)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(document.activeElement).toBe(document.body)
  })

  it('keeps the phone keyboard open when Enter inserts a newline', async () => {
    const onSubmit = await render({ editorOptions: { enterBehavior: 'newline' } })
    await act(async () => { writeComposer(editor(), 'hello'); editor().focus(); editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(editor())
  })

  it.each([{ disabled: true }, { canSubmit: false }, { isWorking: true }, {}])('keeps focus when submission is rejected: %j', async (props) => {
    const onSubmit = await render(props)
    if (props.disabled) return expect(send().disabled).toBe(true)
    await act(async () => {
      if (Object.keys(props).length) writeComposer(editor(), 'hello')
      editor().focus()
      if (props.isWorking) editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      else send().click()
    })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(editor())
  })

  it('keeps desktop focus in the editor', async () => {
    const onSubmit = await render({ mobile: false })
    await act(async () => { writeComposer(editor(), 'hello'); editor().focus(); editor().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('hello')
    expect(document.activeElement).toBe(editor())
  })
})
