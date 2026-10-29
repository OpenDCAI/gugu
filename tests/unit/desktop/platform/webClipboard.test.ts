// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webPlatform } from '@/platform/web'

afterEach(() => vi.unstubAllGlobals())

describe('web clipboard platform', () => {
  it('preserves exact browser text at the platform boundary', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await webPlatform.writeClipboardText('统一出口 中文\nsecond line 😀')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('统一出口 中文\nsecond line 😀')
    expect(webPlatform.capabilities.clipboard).toBe(true)
  })
  it('preserves browser refusal for existing caller feedback', async () => {
    const error = new Error('Write permission denied.')
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(error) } })
    await expect(webPlatform.writeClipboardText('refused')).rejects.toBe(error)
  })
})
