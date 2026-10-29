// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { capacitorPlatform } from '../../../../apps/desktop/src/platform/capacitor'

const { writeText } = vi.hoisted(() => ({ writeText: vi.fn() }))
vi.mock('@capacitor/clipboard', () => ({ Clipboard: { write: writeText } }))
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeFormat: { QrCode: 'QR_CODE' }, BarcodeScanner: {} }))

beforeEach(() => { writeText.mockReset() })

describe('Capacitor native clipboard', () => {
  it.each(['Copy 938 中文 😀\nsecond line\tend', 'https://example.com/a?x=1&y=two#fragment', ''])('writes the exact text through the native bridge: %j', async (value) => {
    writeText.mockResolvedValue(undefined)
    await expect(capacitorPlatform.writeClipboardText(value)).resolves.toBeUndefined()
    expect(writeText).toHaveBeenCalledExactlyOnceWith({ string: value })
    expect(capacitorPlatform.capabilities.clipboard).toBe(true)
  })

  it('waits for the native write before reporting success', async () => {
    let resolveWrite!: () => void
    writeText.mockReturnValue(new Promise<void>((resolve) => { resolveWrite = resolve }))
    let settled = false
    const copy = capacitorPlatform.writeClipboardText('pending').then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(writeText).toHaveBeenCalledExactlyOnceWith({ string: 'pending' })
    expect(settled).toBe(false)
    resolveWrite()
    await copy
    expect(settled).toBe(true)
  })

  it('preserves native rejection for the existing copy-failed feedback', async () => {
    const failure = new Error('Native clipboard unavailable')
    writeText.mockRejectedValue(failure)
    await expect(capacitorPlatform.writeClipboardText('failed')).rejects.toBe(failure)
    expect(writeText).toHaveBeenCalledOnce()
  })
})
