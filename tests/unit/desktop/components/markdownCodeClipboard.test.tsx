// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/markdown/Markdown'
import { markdownCodeHighlighter } from '@/components/markdown/codeHighlight'
import { platform } from '@/platform'
import * as notices from '@/lib/notices'
import { clickElement, createReactHarness, deferred } from '../../../support/testHarness'

const CODE = 'const message = "中文剪贴板";\nconsole.log(message);\n'
const CONTENT = `\`\`\`javascript\n${CODE}\`\`\``
let harness: ReturnType<typeof createReactHarness>
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const browserWrite = vi.fn()
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    const result = markdownCodeHighlighter.highlight({ code: CODE.trimEnd(), language: 'javascript', themes: markdownCodeHighlighter.getThemes() }, () => resolve())
    if (result) resolve()
  })
})
beforeEach(() => {
  harness = createReactHarness()
  browserWrite.mockReset().mockRejectedValue(new Error('WebView write denied'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: browserWrite } })
})
afterEach(() => {
  harness.cleanup()
  if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})
async function renderCopy(trust: 'chat' | 'document', codeCopy = false) {
  await harness.render(<Markdown trust={trust} codeCopy={codeCopy} content={CONTENT} />)
  const button = harness.container.querySelector<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')
  expect(button, `${trust} code copy must be reachable`).not.toBeNull()
  return button!
}
describe('Markdown code copies use the host transport', () => {
  it.each(['chat', 'document'] as const)('%s copies raw multiline Chinese code without fences', async (trust) => {
    const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
    const button = await renderCopy(trust, true)
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(CODE)
    expect(browserWrite).not.toHaveBeenCalled()
    expect(button.dataset.copied).toBe('true')
  })
  it('shows success only after the native write resolves', async () => {
    const pending = deferred<void>()
    vi.spyOn(platform, 'writeClipboardText').mockReturnValue(pending.promise)
    const button = await renderCopy('document')
    await clickElement(button)
    expect(button.dataset.copied).not.toBe('true')
    await act(async () => pending.resolve())
    expect(button.dataset.copied).toBe('true')
    expect(browserWrite).not.toHaveBeenCalled()
  })
  it('reports native refusal without showing copied or falling back to the browser', async () => {
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(new Error('Native refused'))
    const notify = vi.spyOn(notices, 'notify').mockImplementation(() => 0)
    const button = await renderCopy('document')
    await clickElement(button)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', description: expect.stringContaining('Native refused') }))
    expect(button.dataset.copied).not.toBe('true')
    expect(browserWrite).not.toHaveBeenCalled()
  })
  it('keeps code copying opt-in for chat and leaves inline code alone', async () => {
    await harness.render(<Markdown trust="chat" content={CONTENT} />)
    expect(harness.container.querySelector('button')).toBeNull()
    await harness.render(<Markdown trust="chat" codeCopy content={'inline `hello`'} />)
    expect(harness.container.querySelector('[data-streamdown="inline-code"]')?.textContent).toBe('hello')
    expect(harness.container.querySelector('button')).toBeNull()
  })
  it('keeps the chat HTML/image/table capability boundary when code copying is enabled', async () => {
    await harness.render(<Markdown trust="chat" codeCopy content={`${CONTENT}\n\n<img src="https://example.com/private.png">\n\n![image](https://example.com/image.png)\n\n|a|b|\n|-|-|\n|1|2|`} />)
    expect(harness.container.querySelector('img')).toBeNull()
    expect(harness.container.querySelectorAll('[data-streamdown="code-block-copy-button"]')).toHaveLength(1)
    expect(harness.container.querySelectorAll('button')).toHaveLength(1)
  })
})
