// @vitest-environment jsdom
import { verifiedFileHandle } from '../../../helpers/verifiedFileHandle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * #7290 An App's 「另存」 on the phone takes the one save every 「保存」 takes (platform.saveFile — the system's
 * 「保存到…」), under the file's own name. A file whose bytes are in OSS has a link named by its hash
 * (attachments/urls), so the name never comes from the link: it is the file's own (`downloadSource().name`).
 * Cancelled in the system picker answers false, as on the desktop (its save dialog).
 */
const ORIGIN = 'https://board.acct.apps.gugu.invalid'
const CHAT = '0b000000-0000-4000-8000-000000007290'
const CDN = 'https://cdn.example.test/ab/abababab?auth_key=1'
const saved = vi.hoisted(() => ({ calls: [] as { text: string; name: string }[], answer: true }))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      saveFile: async (blob: Blob, name: string) => {
        saved.calls.push({ text: await blob.text(), name })
        return { saved: saved.answer }
      },
    },
  }
})
vi.mock('../../../../apps/desktop/src/session/shared/extensions/app-files-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/session/shared/extensions/app-files-core')>()
  return {
    ...actual,
    createAppFiles: () => ({ downloadSource: async () => ({ name: '季度报告.pdf', kind: 'file', file: await verifiedFileHandle(new TextEncoder().encode(`bytes of ${CDN}`), { file_name: '季度报告.pdf' }) }) }),
  }
})
const activation = { isActive: true }
Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true })

const { hostAppFrame } = await import('../../../../apps/desktop/src/components/appSlot/phoneAppHost')
const { APP_FRAME_MARKER } = await import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol')

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
beforeEach(() => {
  saved.calls.length = 0
  saved.answer = true
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  host = hostAppFrame(
    frame,
    { extensionId: 'board', tabId: 'tab-1', tabName: 'main', chatId: CHAT, capabilities: ['files:read', 'files:write'], locale: 'en-US', themeMode: 'light' },
    { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome: vi.fn() },
  )
})
afterEach(() => {
  host?.dispose()
  frame.remove()
})

async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = Date.now()
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args }, source: frame.contentWindow, origin: ORIGIN }))
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: number }).id === id)).toBe(true))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}

describe('#7290 saving a group file on the phone', () => {
  it('the system takes it under the file\'s own name, not the hash its link is named by', async () => {
    const answer = await call('filesDownload', { ref: { chat: CHAT, name: '季度报告.pdf' } })
    // A refusal says why first (its message), then that it was one.
    expect([answer.code ?? null, answer.message ?? null]).toEqual([null, null])
    expect(answer.ok).toBe(true)
    expect(answer.value).toBe(true)
    expect(saved.calls).toEqual([{ text: `bytes of ${CDN}`, name: '季度报告.pdf' }])
  })

  it('cancelled in the system picker is false, not a failure', async () => {
    saved.answer = false
    const answer = await call('filesDownload', { ref: { chat: CHAT, name: '季度报告.pdf' } })
    expect([answer.code ?? null, answer.message ?? null]).toEqual([null, null])
    expect(answer.ok).toBe(true)
    expect(answer.value).toBe(false)
  })
})
