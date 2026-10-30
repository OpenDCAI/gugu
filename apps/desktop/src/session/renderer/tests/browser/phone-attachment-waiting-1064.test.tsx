import { act } from 'react'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { SessionConversation } from '@/mobile/agent-watch/SessionConversation'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/i18n'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@/components/assistant-ui/session-transcript-view.aui', () => ({
  SessionTranscriptView: ({ composerContent }: { composerContent: import('react').ReactNode }) => <div>{composerContent}</div>,
}))

const { writeChunk } = vi.hoisted(() => ({ writeChunk: vi.fn() }))
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/mobile/agent-watch/sessionpage-rpc')>(),
  SessionpageRpcError: class extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: () => ({
    writeAttachmentChunk: writeChunk,
    commitAttachmentUpload: async ({ name, size }: { name: string; size: number }) => ({
      success: true, data: { id: name, storedPath: `/uploads/${name}`, mentionPath: `/uploads/${name}`, name, size },
    }),
    discardAttachmentUpload: async () => ({ success: true, data: undefined }),
  }),
}))

let harness: ReturnType<typeof createReactHarness> | null = null
let release = () => {}
let failUpload = false
beforeEach(async () => {
  await page.viewport(390, 844)
  failUpload = false
  const gate = new Promise<void>((resolve) => { release = resolve })
  writeChunk.mockReset().mockImplementation(async (chunk) => {
    await gate
    if (failUpload) throw new Error("Upload refused")
    return { success: true, data: { received: chunk.offset + chunk.data.byteLength } }
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
  const onSend = vi.fn(async (_text: string) => {})
  harness = createReactHarness()
  await renderWithAppProviders(harness, <SessionConversation timeline={emptyAgentWatchTimeline()} deviceId="device" sessionId="task" agentName="Test agent" sessionRuntime="acp"
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
  await until('upload is waiting on real attachment RPC', () => writeChunk.mock.calls.length === 1)
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
  expect(onSend.mock.calls[0]![0]).toContain('/uploads/first.bin')
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
  await until('upload started', () => writeChunk.mock.calls.length === 1)
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
