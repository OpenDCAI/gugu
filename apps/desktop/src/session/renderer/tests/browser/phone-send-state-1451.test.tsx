import { createRef, useState } from 'react'
import { createChatContext, createChatState, type ChatView } from '@gugu/session-chat-ui'
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view'
import { messageUnitDef } from '@session-chat/components/rows/message/message.def'
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


it('editing only the composer keeps rendered historical messages mounted', async () => {
  await page.viewport(390, 844)
  const context = createChatContext({ locale: () => 'en-US' })
  const state = createChatState(context)
  state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'old-user', seq: 0, role: 'user', text: 'Existing user message' },
    { kind: 'message', id: 'old-agent', seq: 1, role: 'assistant', text: 'Existing agent response' },
  ] }])
  const commands = { onOpenLink: vi.fn() }
  let edit!: (text: string) => void
  let view!: ChatView
  function Fixture() {
    const [text, setText] = useState('draft')
    edit = setText
    return <AgentConversationView context={context} state={state} commands={commands} onReady={ready => { view = ready }} composerContent={<div style={{ height: 48 }}>{text}</div>} />
  }
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;inset:0;width:390px;height:844px'
  root = createRoot(host)
  try {
    root.render(<Fixture />)
    await until('historical message rendered', () => !!host?.querySelector('[data-agent-conversation-message="old-user"]'))
    const row = host.querySelector('[data-agent-conversation-message="old-user"]')!
    const body = row.firstChild
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const publish = vi.spyOn(view, 'setCommands')
    edit('new draft')
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(row.isConnected).toBe(true)
    expect(host.querySelector('[data-agent-conversation-message="old-user"]')).toBe(row)
    expect(row.firstChild).toBe(body)
    expect(publish).not.toHaveBeenCalled()
  } finally { root.unmount(); root = null; state.dispose(); context.dispose() }
})

it('committing a new input does not remeasure unrelated historical bubbles', async () => {
  await page.viewport(390, 844)
  const context = createChatContext({ locale: () => 'en-US' })
  const state = createChatState(context)
  state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'old-user', seq: 0, role: 'user', text: 'Existing user message' },
    { kind: 'message', id: 'old-agent', seq: 1, role: 'assistant', text: 'Existing agent response' },
  ] }])
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'position:fixed;inset:0;width:390px;height:844px'
  root = createRoot(host)
  try {
    root.render(<AgentConversationView context={context} state={state} commands={{ onOpenLink: vi.fn() }} />)
    await until('old messages rendered', () => !!host?.querySelector('[data-agent-conversation-message="old-agent"]'))
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const measure = vi.spyOn(messageUnitDef, 'measure')
    state.session.setPendingPrompt({ id: 'new-input', text: 'New locally committed input', sentAt: Date.now(), held: true, delivery: { state: 'sending' } })
    await until('new input rendered', () => !!host?.querySelector('[data-agent-conversation-message="new-input"]'))
    expect(measure.mock.calls.filter(([item]) => item.id === 'old-user')).toHaveLength(0)
    expect(measure.mock.calls.some(([item]) => item.id === 'old-agent')).toBe(true)
    measure.mockRestore()
  } finally { root.unmount(); root = null; state.dispose(); context.dispose() }
})
