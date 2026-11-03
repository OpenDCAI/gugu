// @vitest-environment jsdom
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatComposer, MessageProvider, type PromptEditorRef } from '@gugu/session-ui/react/components'
import { ThemeProvider } from '@gugu/session-ui/react/primitives'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'

let harness: ReturnType<typeof createReactHarness>
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
const editor = () => harness.container.querySelector<HTMLElement>('[contenteditable]')!
const send = () => harness.container.querySelector<HTMLButtonElement>(`button[aria-label="${translateSessionMessage('composer.sendMessage')}"]`)
const stop = () => harness.container.querySelector<HTMLButtonElement>('[data-composer-action="stop"]')
beforeEach(() => { harness = createReactHarness(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 }) })
afterEach(() => { harness.cleanup(); Object.defineProperty(window, 'innerWidth', width) })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function mount(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  await harness.render(<ThemeProvider><MessageProvider locale="en-US" translate={translateSessionMessage}><ChatComposer mobile onSubmit={() => {}} {...props} /></MessageProvider></ThemeProvider>)
}

describe('phone send / stop state', () => {
  it.each([false, true])('empty draft while working=%s', async isWorking => {
    await mount({ isWorking })
    if (isWorking) { expect(stop()).not.toBeNull(); expect(send()).toBeNull() }
    else { expect(send()?.disabled).toBe(true); expect(stop()).toBeNull() }
  })
  it.each([false, true])('text takes precedence while working=%s', async isWorking => {
    const onSubmit = vi.fn(), onSubmitWhileWorking = vi.fn(), onStop = vi.fn()
    await mount({ isWorking, onSubmit, onSubmitWhileWorking, onStop })
    await act(async () => writeComposer(editor(), 'hello'))
    expect(send()?.disabled).toBe(false)
    expect(stop()).toBeNull()
    await act(async () => send()!.click())
    expect(isWorking ? onSubmitWhileWorking : onSubmit).toHaveBeenCalledExactlyOnceWith('hello')
    expect(onStop).not.toHaveBeenCalled()
  })
  it('an attachment also takes precedence over Stop', async () => {
    const submit = vi.fn()
    await mount({ isWorking: true, attachments: [{ id: 'file', name: 'notes.txt', kind: 'file' }], onSubmitWhileWorking: submit })
    expect(send()?.disabled).toBe(false)
    await act(async () => send()!.click())
    expect(submit).toHaveBeenCalledExactlyOnceWith('')
  })
  it('keeps Send disabled across three taps until the cleared draft is locally committed', async () => {
    const commit = deferred(), api = createRef<PromptEditorRef>(), onStop = vi.fn()
    const submit = vi.fn(() => { api.current!.clear(); return commit.promise })
    await mount({ isWorking: true, editorApiRef: api, editorOptions: { clearOnSubmit: false }, onSubmitWhileWorking: submit, onStop })
    await act(async () => writeComposer(editor(), 'queue this'))
    await act(async () => { send()!.click(); send()!.click(); send()!.click() })
    expect(readComposer(editor())).toBe('')
    expect(send()?.disabled).toBe(true)
    expect(stop()).toBeNull()
    expect(submit).toHaveBeenCalledTimes(1)
    expect(onStop).not.toHaveBeenCalled()
    await act(async () => commit.resolve())
    expect(send()).toBeNull()
    expect(stop()?.disabled).toBe(false)
  })
  it('preserves the desktop working button with a nonempty draft', async () => {
    await mount({ mobile: false, isWorking: true })
    await act(async () => writeComposer(editor(), 'desktop'))
    expect(stop()).not.toBeNull()
    expect(send()).toBeNull()
  })
  it('preserves Stop in a compact desktop preview', async () => {
    await mount({ mobile: true, phoneActions: false, isWorking: true })
    await act(async () => writeComposer(editor(), 'desktop preview'))
    expect(stop()).not.toBeNull()
    expect(send()).toBeNull()
  })
  it('uses the chat host local enqueue promise rather than switching on draft clear', async () => {
    const commit = deferred(), onSend = vi.fn(() => commit.promise), onStop = vi.fn()
    await renderWithAppProviders(harness, <ChatMessageComposer chatId="chat" onSend={onSend} conversation={{ isWorking: true, onStop }} />)
    await act(async () => writeComposer(editor(), 'chat intent'))
    await act(async () => send()!.click())
    expect(onSend).toHaveBeenCalledExactlyOnceWith('chat intent', expect.any(Object))
    expect(readComposer(editor())).toBe('')
    expect(send()?.disabled).toBe(true)
    expect(stop()).toBeNull()
    await act(async () => commit.resolve())
    expect(stop()).not.toBeNull()
    expect(onStop).not.toHaveBeenCalled()
  })
})
