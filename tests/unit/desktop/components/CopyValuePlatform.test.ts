// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyValue } from '@/components/CopyValue'
import { platform } from '@/platform'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('shared copy control uses its host', () => {
  it('copies exact text through the platform even if the WebView rejects browser clipboard writes', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Write permission denied.'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const native = vi.spyOn(platform, 'writeClipboardText').mockResolvedValue(undefined)
    await renderWithAppProviders(harness, createNode(CopyValue, { value: '连接代码 中文\nsecond line', message: 'Copied' }))
    await clickElement(harness.container.querySelector('button')!)
    expect(native).toHaveBeenCalledExactlyOnceWith('连接代码 中文\nsecond line')
    expect(writeText).not.toHaveBeenCalled()
  })
  it('keeps the inline failure visible when the host refuses', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(new Error('Native clipboard refused'))
    await renderWithAppProviders(harness, createNode(CopyValue, { value: 'exact', message: 'Copied', feedback: 'inline' }))
    await clickElement(harness.container.querySelector('button')!)
    expect(harness.container.textContent).toContain('Native clipboard refused')
    expect(harness.container.textContent).not.toContain('Copied')
    expect(writeText).not.toHaveBeenCalled()
  })
})
