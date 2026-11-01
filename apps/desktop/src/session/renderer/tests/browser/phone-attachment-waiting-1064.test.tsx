import { act } from 'react'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/i18n'
import { publishRendererSession } from '@/lib/sessionPublication'
import { chatService } from '@/lib/chat'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@/components/assistant-ui/session-transcript-view.aui', () => ({
  SessionTranscriptView: ({ composerContent }: { composerContent: import('react').ReactNode }) => <div>{composerContent}</div>,
}))

// 附件放进 agent 私聊的文件夹(P3):`place` 是那一步,放好交回引用。
const { place } = vi.hoisted(() => ({ place: vi.fn() }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/mobile/agent-watch/sessionpage-rpc')>(),
  SessionpageRpcError: class extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
}))
vi.mock('@/lib/attachmentsEndpoint', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/attachmentsEndpoint')>(),
  placeTaskAttachment: (file: File) => place(file),
  prepareTaskAttachment: async () => null,
}))
const placed = (file: File) => ({ itemId: file.name, version: 1, name: file.name, mimeType: file.type, sizeBytes: file.size })
const sentNames = (call: unknown[] | undefined) => ((call?.[1] ?? []) as Array<{ name: string }>).map((file) => file.name)

let harness: ReturnType<typeof createReactHarness> | null = null
let release = () => {}
let failUpload = false
beforeEach(async () => {
  await page.viewport(390, 844)
  // 放附件要一个私聊(P3):登录的人与这个 agent 的那一条。
  publishRendererSession('SIGNED_IN', { user: { id: 'owner' } } as never)
  vi.spyOn(chatService, 'getOrCreateDM').mockResolvedValue('dm')
  failUpload = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  place.mockReset().mockImplementation(async (file: File) => {
    await gate
    if (failUpload) throw new Error("Upload refused")
    return placed(file)
  })
})
afterEach(async () => {
  release()
  await Promise.resolve()
  harness?.cleanup()
  harness = null
  document.body.replaceChildren()
})

async function show() {
  const onSend = vi.fn(async (_text: string, _files?: unknown[]) => {})
  harness = createReactHarness()
  await renderWithAppProviders(harness, <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="device" sessionId="task" agentName="Test agent" agentUserId="agent" sessionRuntime="acp"
    respondingItemId={null} onRespond={vi.fn()} onSend={onSend} pendingSends={[]} sending={false}
    agentWorking={false} onStop={() => {}} stopping={false} onLoadOlder={async () => {}} />)
  return onSend
}

const picker = () => document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!
const status = () => document.querySelector<HTMLElement>('[data-slot="composer-attachment-status"]')
const send = () => act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="composer-actions-end"] > button')!.click() })
async function pick(name: string) {
  await act(async () => {
    const files = new DataTransfer()
    files.items.add(new File(['attachment'], name, { type: 'application/octet-stream' }))
    picker().files = files.files
    picker().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('shows the phone waiting caption only after send, then automatically sends once and clears it', async () => {
  const onSend = await show()
  await until('real phone file picker mounted', () => !!picker())
  await pick('first.bin')
  await until('placement is waiting', () => place.mock.calls.length === 1)
  expect(status()).toBeNull()
  await send()
  expect(status(), 'the running upload must show its waiting caption after send').not.toBeNull()
  expect(status()!.textContent).toBe(translateSessionMessage('composer.attachmentWaiting'))
  expect(status()!.closest('[data-slot="composer-attachments"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="composer-notice"]')).toBeNull()
  expect(document.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!.disabled).toBe(false)
  expect(onSend).not.toHaveBeenCalled()
  await act(async () => { release() })
  await until('queued input automatically delivered once', () => onSend.mock.calls.length === 1)
  expect(sentNames(onSend.mock.calls[0])).toEqual(['first.bin'])
  await until('waiting caption and delivered files cleared', () => !status() && !document.querySelector('[data-slot="composer-attachment"]'))
  expect(onSend).toHaveBeenCalledTimes(1)
  await pick('second.bin')
  const second = () => [...document.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')].find((chip) => chip.textContent?.includes('second.bin'))
  await until('next attachment available', () => !!second())
  expect(status(), 'the earlier send cannot mark a newly picked file as waiting').toBeNull()
  await act(async () => { second()!.querySelector<HTMLButtonElement>('button')!.click() })
  await until('the new attachment can still be cancelled', () => !second())
  expect(onSend).toHaveBeenCalledTimes(1)
})

it.each(['failure', 'cancel'])('clears the pending hint on %s without submitting a message', async (outcome) => {
  const onSend = await show()
  await until('file picker mounted', () => !!picker())
  await pick('interrupted.bin')
  await until('upload started', () => place.mock.calls.length === 1)
  await send()
  expect(status()).not.toBeNull()
  if (outcome === 'failure') {
    failUpload = true
    await act(async () => { release() })
    await until('failed file remains available for retry', () => !!document.querySelector('[data-slot="composer-attachment"][data-state="error"]'))
  } else {
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!.click() })
    await act(async () => { release() })
    await until('cancelled file removed', () => !document.querySelector('[data-slot="composer-attachment"]'))
  }
  await until('interrupted send no longer promises automatic delivery', () => !status())
  expect(onSend).not.toHaveBeenCalled()
  if (outcome === 'failure') {
    expect([...document.querySelectorAll('[data-slot="composer-attachment"] button')].some(button => button.textContent === translateSessionMessage('composer.retryAttachment'))).toBe(true)
  }
})

it('does not show a cancelled batch waiting caption on a replacement that has never been sent', async () => {
  const onSend = await show()
  await until('file picker mounted', () => !!picker())
  await pick('cancel-before-return.bin')
  await until('old upload is held in its chunk RPC', () => place.mock.calls.length === 1)
  await send()
  expect(status()).not.toBeNull()
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!.click()
  })
  await until('cancelled chip removed without resolving its chunk RPC', () => !document.querySelector('[data-slot="composer-attachment"]'))
  await pick('replacement-not-submitted.bin')
  await until('replacement upload started without a second send', () => place.mock.calls.length === 2)
  const replacementCaption = status()?.textContent ?? null
  expect(onSend).not.toHaveBeenCalled()
  await act(async () => { release() })
  await until('old cancelled wait settled and replacement upload finished', () => !status() && !!document.querySelector('[data-slot="composer-attachment"][data-state="done"]'))
  expect(onSend, 'the replacement was never submitted and is not auto-sent').not.toHaveBeenCalled()
  expect(replacementCaption, 'cancelled send intent must not label a replacement file as queued for sending').toBeNull()
})

it('can submit a replacement while the cancelled RPC is pending, and ignores the late old completion', async () => {
  const old = Promise.withResolvers<void>()
  const replacement = Promise.withResolvers<void>()
  let chunks = 0
  place.mockImplementation(async (file: File) => {
    await (++chunks === 1 ? old.promise : replacement.promise)
    return placed(file)
  })
  try {
    const onSend = await show()
    await until('file picker mounted', () => !!picker())
    await pick('cancelled.bin')
    await until('old upload pending', () => place.mock.calls.length === 1)
    await send()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!.click() })
    expect(status(), 'cancelling clears the hint before the old RPC returns').toBeNull()
    await pick('replacement.bin')
    await until('replacement upload pending', () => place.mock.calls.length === 2)
    expect(status()).toBeNull()
    await send()
    expect(status(), 'a fresh send starts a new wait immediately').not.toBeNull()
    await act(async () => { old.resolve() })
    expect(status(), 'late cancellation cannot clear the new submitted batch hint').not.toBeNull()
    expect(onSend).not.toHaveBeenCalled()
    await act(async () => { replacement.resolve() })
    await until('only the replacement is sent', () => onSend.mock.calls.length === 1 && !status())
    expect(sentNames(onSend.mock.calls[0])).toEqual(['replacement.bin'])
    expect(onSend).toHaveBeenCalledTimes(1)
  } finally { old.resolve(); replacement.resolve() }
})

it('sends plain text once without an attachment hint or upload', async () => {
  const onSend = await show()
  await act(async () => { await page.getByTestId('prompt-editor').fill('plain text') })
  await send()
  await until('plain input sent', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]![0]).toBe('plain text')
  expect(place).not.toHaveBeenCalled()
  expect(status()).toBeNull()
})

it('cancels the submitted batch when an already uploaded member is removed', async () => {
  const pending = Promise.withResolvers<void>()
  let chunks = 0
  place.mockImplementation(async (file: File) => {
    if (++chunks > 1) await pending.promise
    return placed(file)
  })
  try {
    const onSend = await show()
    await until('file picker mounted', () => !!picker())
    await pick('already-uploaded.bin')
    await until('first member uploaded', () => !!document.querySelector('[data-slot="composer-attachment"][data-state="done"]'))
    await pick('still-uploading.bin')
    await until('second member pending', () => place.mock.calls.length === 2)
    await send()
    expect(status()).not.toBeNull()
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"][data-state="done"] button')!.click() })
    expect(status()).toBeNull()
    await send()
    expect(status()).not.toBeNull()
    await act(async () => { pending.resolve() })
    await until('remaining member sent only once', () => onSend.mock.calls.length === 1 && !status())
    expect(sentNames(onSend.mock.calls[0])).toEqual(['still-uploading.bin'])
    expect(onSend).toHaveBeenCalledTimes(1)
  } finally { pending.resolve() }
})
