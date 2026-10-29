// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { platform } from '@/platform'
import * as notices from '@/lib/notices'
import { markdownCodeHighlighter } from '@/components/markdown/codeHighlight'
import { clickElement, createReactHarness, deferred } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { emptyAgentWatchTimeline } = await import('../../../apps/desktop/src/mobile/agent-watch/agent-watch-store')
const TEXT = '```javascript\nconst message = "中文剪贴板";\nconsole.log(message);\n```'
const turns = [{
  id: 'clipboard-turn', seq: 1, initiator: 'user', outcome: { kind: 'done' },
  items: [
    { kind: 'message', id: 'prompt', seq: 0, role: 'user', text: 'reply with code' },
    { kind: 'message', id: 'code', seq: 1, role: 'assistant', text: TEXT },
  ],
}] as TranscriptTurn[]

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    const result = markdownCodeHighlighter.highlight({ code: 'const message = "中文剪贴板";\nconsole.log(message);', language: 'javascript', themes: markdownCodeHighlighter.getThemes() }, () => resolve())
    if (result) resolve()
  })
})

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const browserWrite = vi.fn()
beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
  browserWrite.mockReset().mockRejectedValue(new Error('WebView clipboard denied'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: browserWrite } })
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

async function renderCopyButton() {
  await harness.render(<AgentThread
    timeline={{ ...emptyAgentWatchTimeline(), turns }} deviceId="test-device" sessionId="test-session" sessionRuntime="acp"
    respondingItemId={null} onRespond={() => undefined} onSend={async () => undefined} pendingSends={[]}
    sending={false} agentWorking={false} headerRunning={false} onStop={() => undefined} stopping={false}
    onLoadOlder={async () => undefined}
  />)
  const button = harness.container.querySelector<HTMLButtonElement>('[data-slot="assistant-turn"][data-last="true"] [data-slot="aui_assistant-message-footer"] button')
  expect(button, 'the real task-reply action bar must render').not.toBeNull()
  return button!
}

describe('real phone task reply copy uses the platform', () => {
  it('copies the complete multiline Chinese reply through the host while the WebView refuses writes', async () => {
    const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
    const button = await renderCopyButton()
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(TEXT)
    expect(browserWrite).not.toHaveBeenCalled()
    expect(button.dataset.copied).toBe('true')
  })

  it('exposes a distinct code-block action which copies only raw code', async () => {
    const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
    await renderCopyButton()
    const blockButton = harness.container.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')
    expect(blockButton, 'the real task renderer must opt into block copying').not.toBeNull()
    await clickElement(blockButton!)
    expect(write).toHaveBeenCalledExactlyOnceWith('const message = "中文剪贴板";\nconsole.log(message);\n')
    expect(browserWrite).not.toHaveBeenCalled()
  })

  it('waits for the native write before showing copied feedback', async () => {
    const pending = deferred<void>()
    const write = vi.spyOn(platform, 'writeClipboardText').mockReturnValue(pending.promise)
    const button = await renderCopyButton()
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(TEXT)
    expect(button.dataset.copied).not.toBe('true')
    await act(async () => pending.resolve())
    expect(button.dataset.copied).toBe('true')
    expect(browserWrite).not.toHaveBeenCalled()
  })

  it('reports a native refusal and leaves copied feedback unset without browser fallback', async () => {
    const error = new Error('Native clipboard refused')
    const write = vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(error)
    const notify = vi.spyOn(notices, 'notify').mockImplementation(() => 0)
    const button = await renderCopyButton()
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(TEXT)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', description: expect.stringContaining(error.message) }))
    expect(button.dataset.copied).not.toBe('true')
    expect(browserWrite).not.toHaveBeenCalled()
  })
})
