// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/markdown/Markdown'
import { platform } from '@/platform'
import * as notices from '@/lib/notices'
import { clickElement, createReactHarness, deferred } from '../../../support/testHarness'

const CONTENT = '| 项目 | 数值 |\n| --- | --- |\n| 中文 | 37 |\n| second | 29 |'
const TSV = '项目\t数值\n中文\t37\nsecond\t29'
let harness: ReturnType<typeof createReactHarness>
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const kindDescriptor = Object.getOwnPropertyDescriptor(platform, 'kind')!
const writeRich = vi.fn()
beforeEach(() => {
  harness = createReactHarness()
  vi.stubGlobal('innerWidth', 390)
  writeRich.mockReset().mockRejectedValue(new Error('WebView rich copy refused'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: writeRich } })
  vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob>) {} })
})
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(platform, 'kind', kindDescriptor)
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
})
async function copyAction(root: ParentNode) {
  const native = root.querySelector<HTMLButtonElement>('[data-streamdown="table-copy-button"]')
  if (native) return native
  // Exercise the previous dependency-owned control too: red must fail on the writer/content, not its selector.
  const legacy = root.querySelector<HTMLButtonElement>('[title="Copy table"]')
  expect(legacy, 'the original table-copy control must be present').not.toBeNull()
  await clickElement(legacy!)
  const tsv = [...root.querySelectorAll('button')].find(button => button.textContent === 'TSV')
  expect(tsv, 'the original TSV choice must be present').not.toBeUndefined()
  return tsv!
}
async function renderCopy() {
  await harness.render(<Markdown trust="document" content={CONTENT} />)
  return copyAction(harness.container)
}
describe('phone document table clipboard', () => {
  it.each(['web', 'capacitor'] as const)('copies complete headers and rows as TSV through the %s phone platform', async kind => {
    vi.stubGlobal('innerWidth', kind === 'web' ? 390 : 1280)
    Object.defineProperty(platform, 'kind', { configurable: true, value: kind })
    const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
    const button = await renderCopy()
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(TSV)
    expect(writeRich).not.toHaveBeenCalled()
    expect(button.dataset.copied).toBe('true')
    expect(harness.container.querySelector('[title="Download table"]')).not.toBeNull()
    expect(harness.container.querySelector('[title="View fullscreen"]')).not.toBeNull()
  })
  it('waits for the platform before showing copied', async () => {
    const pending = deferred<void>()
    const write = vi.spyOn(platform, 'writeClipboardText').mockReturnValue(pending.promise)
    const button = await renderCopy()
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(TSV)
    expect(button.dataset.copied).not.toBe('true')
    await act(async () => pending.resolve())
    expect(button.dataset.copied).toBe('true')
  })
  it('reports native refusal and leaves success unset without rich-copy fallback', async () => {
    const write = vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(new Error('Native table refused'))
    const notify = vi.spyOn(notices, 'notify').mockImplementation(() => 0)
    const button = await renderCopy()
    await clickElement(button)
    expect(write).toHaveBeenCalledExactlyOnceWith(TSV)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', description: expect.stringContaining('Native table refused') }))
    expect(button.dataset.copied).not.toBe('true')
    expect(writeRich).not.toHaveBeenCalled()
  })
  it('also copies TSV from the expanded table', async () => {
    const write = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
    await renderCopy()
    await clickElement(harness.container.querySelector<HTMLButtonElement>('[title="View fullscreen"]')!)
    const expanded = document.querySelector('[role="dialog"]')
    expect(expanded?.querySelector('table')?.textContent).toContain('second')
    await clickElement(expanded!.querySelector<HTMLButtonElement>('[data-streamdown="table-copy-button"]')!)
    expect(write).toHaveBeenCalledExactlyOnceWith(TSV)
    expect(writeRich).not.toHaveBeenCalled()
  })
  it.each(['web', 'electron'] as const)('retains %s desktop text and HTML clipboard formats', async kind => {
    vi.stubGlobal('innerWidth', kind === 'web' ? 1024 : 390)
    Object.defineProperty(platform, 'kind', { configurable: true, value: kind })
    const native = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue()
    writeRich.mockResolvedValue(undefined)
    await harness.render(<Markdown trust="document" content={CONTENT} />)
    expect(harness.container.querySelector('[data-streamdown="table-copy-button"]')).toBeNull()
    await clickElement(harness.container.querySelector<HTMLButtonElement>('[title="Copy table"]')!)
    await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === 'TSV')!)
    expect(writeRich).toHaveBeenCalledTimes(1)
    const item = writeRich.mock.calls[0][0][0] as { data: Record<string, Blob> }
    expect(Object.keys(item.data)).toEqual(['text/plain', 'text/html'])
    const readBlob = (blob: Blob) => new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob) })
    expect(await readBlob(item.data['text/plain'])).toBe(TSV)
    expect(await readBlob(item.data['text/html'])).toContain('<table')
    expect(native).not.toHaveBeenCalled()
  })
})
