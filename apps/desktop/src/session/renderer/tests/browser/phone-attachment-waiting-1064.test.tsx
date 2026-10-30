import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { AgentThread } from '@/mobile/agent-watch/AgentThread'
import { emptyAgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import '@/i18n'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

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

let root: Root | null = null
let release = () => {}
beforeEach(async () => {
  await page.viewport(390, 844)
  const gate = new Promise<void>((resolve) => { release = resolve })
  writeChunk.mockReset().mockImplementation(async (chunk) => {
    await gate
    return { success: true, data: { received: chunk.offset + chunk.data.byteLength } }
  })
})
afterEach(async () => {
  release()
  await Promise.resolve()
  root?.unmount()
  root = null
  document.body.replaceChildren()
})

it('shows the phone waiting caption only after send, then automatically sends once and clears it', async () => {
  const onSend = vi.fn(async (_text: string) => {})
  root = createRoot(document.body.appendChild(document.createElement('div')))
  root.render(<AgentThread timeline={emptyAgentWatchTimeline()} deviceId="device" sessionId="task" sessionRuntime="acp"
    respondingItemId={null} onRespond={() => {}} onSend={onSend} pendingSends={[]} sending={false}
    agentWorking={false} onStop={() => {}} stopping={false} onLoadOlder={async () => {}} />)
  const picker = () => document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!
  await until('real phone file picker mounted', () => !!picker())
  const pick = (name: string) => {
    const files = new DataTransfer()
    files.items.add(new File(['attachment'], name, { type: 'application/octet-stream' }))
    picker().files = files.files
    picker().dispatchEvent(new Event('change', { bubbles: true }))
  }
  const status = () => document.querySelector<HTMLElement>('[data-slot="composer-attachment-status"]')
  pick('first.bin')
  await until('upload is waiting on real attachment RPC', () => writeChunk.mock.calls.length === 1)
  expect(status()).toBeNull()
  document.querySelector<HTMLButtonElement>('[data-slot="composer-actions-end"] > button')!.click()
  await until('SDK send is waiting on attachment', () => document.querySelector<HTMLButtonElement>('[data-slot="composer-actions-end"] > button')!.disabled)
  expect(status(), 'the running upload must show its waiting caption after send').not.toBeNull()
  expect(status()!.textContent).toBe(translateSessionMessage('composer.attachmentWaiting'))
  expect(status()!.closest('[data-slot="composer-attachments"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="composer-notice"]')).toBeNull()
  expect(document.querySelector<HTMLButtonElement>('[data-slot="composer-attachment"] button')!.disabled).toBe(false)
  expect(onSend).not.toHaveBeenCalled()
  release()
  await until('queued input automatically delivered once', () => onSend.mock.calls.length === 1)
  expect(onSend.mock.calls[0]![0]).toContain('/uploads/first.bin')
  await until('waiting caption cleared', () => !status())
  expect(onSend).toHaveBeenCalledTimes(1)
  pick('second.bin')
  const second = () => [...document.querySelectorAll<HTMLElement>('[data-slot="composer-attachment"]')].find((chip) => chip.textContent?.includes('second.bin'))
  await until('next attachment available', () => !!second())
  expect(status(), 'the earlier send cannot mark a newly picked file as waiting').toBeNull()
  second()!.querySelector<HTMLButtonElement>('button')!.click()
  await until('the new attachment can still be cancelled', () => !second())
  expect(onSend).toHaveBeenCalledTimes(1)
})
