// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CopyValue } from '../../../../apps/desktop/src/components/CopyValue'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const harnesses: ReturnType<typeof createReactHarness>[] = []
afterEach(() => { harnesses.splice(0).forEach((harness) => harness.cleanup()); vi.unstubAllGlobals() })

describe('copy failure cause', () => {
  it.each(['toast', 'inline'] as const)('preserves the sanitized rejection in %s feedback', async (feedback) => {
    const invoke = vi.fn(async () => undefined)
    vi.stubGlobal('electronAPI', { invoke })
    const writeText = vi.fn().mockRejectedValue(new Error('Clipboard denied /Users/test/private sk-synthetic-secret\nstack detail'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const toast = vi.fn()
    const harness = createReactHarness()
    harnesses.push(harness)
    await renderWithAppProviders(harness, createNode(CopyValue, { value: 'copy me', message: 'Copied', feedback }), { toast })
    await clickElement(harness.container.querySelector('button')!)
    expect(writeText).toHaveBeenCalledWith('copy me')
    const reason = 'Clipboard denied [path] [redacted token]'
    if (feedback === 'inline') expect(harness.container.querySelector('[aria-live]')?.textContent).toBe(reason)
    else expect(toast).toHaveBeenCalledWith('复制失败', 'error', reason)
    expect(invoke).toHaveBeenCalledWith('log:write', expect.objectContaining({ level: 'error', msg: 'clipboard copy failed' }))
  })
})
