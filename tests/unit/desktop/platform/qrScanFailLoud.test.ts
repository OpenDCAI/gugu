// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// @@@scan-fail-loud (#1122) — the capacitor QR scanner must distinguish a real native error
// (denied permission / missing ML Kit model / plugin/device error) from a genuine user cancel.
// Real errors REJECT (caller toasts); only an explicit cancel resolves null. Mocks the ML Kit
// plugin so the adapter logic runs in jsdom.

const { requestPermissions, addListener, startScan, removeAllListeners, stopScan } = vi.hoisted(() => ({
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  startScan: vi.fn(),
  removeAllListeners: vi.fn(),
  stopScan: vi.fn(),
}))

vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeFormat: { QrCode: 'QR_CODE' },
  BarcodeScanner: { requestPermissions, addListener, startScan, removeAllListeners, stopScan },
}))

import { capacitorPlatform } from '../../../../apps/desktop/src/platform/capacitor'
import { describeBarcodeScanError } from '../../../../apps/desktop/src/lib/barcodeScanError'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { PlatformError } from '../../../../apps/desktop/src/platform/errors'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  requestPermissions.mockReset().mockResolvedValue({ camera: 'granted' })
  addListener.mockReset().mockResolvedValue({ remove: vi.fn() })
  startScan.mockReset().mockResolvedValue(undefined)
  removeAllListeners.mockReset().mockResolvedValue(undefined)
  stopScan.mockReset().mockResolvedValue(undefined)
  document.body.innerHTML = ''
  document.body.className = ''
  void capacitorPlatform.syncResolvedLocale('zh-CN')
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('capacitor scanQrCode — fail-loud (#1122)', () => {
  it('rejects (not null) when camera permission is denied', async () => {
    requestPermissions.mockResolvedValue({ camera: 'denied' })
    const error = await capacitorPlatform.scanQrCode().catch((caught) => caught)
    expect(error).toMatchObject({ code: 'BARCODE_SCAN_CAMERA_PERMISSION_DENIED' })
    expect(describeBarcodeScanError(error, i18n.getFixedT('zh-CN', 'main'))).toBe('相机权限被拒绝')
  })

  it('rejects (not null) when startScan fails — missing ML Kit model / device error', async () => {
    const cause = new Error('ML Kit barcode model unavailable')
    startScan.mockRejectedValue(cause)
    await expect(capacitorPlatform.scanQrCode()).rejects.toMatchObject({
      code: 'BARCODE_SCAN_FAILED',
      cause,
    })
    expect(describeBarcodeScanError(
      new PlatformError('BARCODE_SCAN_FAILED', { cause }),
      i18n.getFixedT('zh-CN', 'main'),
    )).toBe('ML Kit barcode model unavailable')
  })

  it('rejects (not null) when listener init fails', async () => {
    addListener.mockRejectedValue(new Error('plugin not available'))
    await expect(capacitorPlatform.scanQrCode()).rejects.toBeInstanceOf(PlatformError)
  })

  it('resolves the scanned value on success', async () => {
    let listenerCb: ((e: { barcodes?: { rawValue?: string }[] }) => void) | undefined
    addListener.mockImplementation((_event: string, cb: (e: { barcodes?: { rawValue?: string }[] }) => void) => {
      listenerCb = cb
      return Promise.resolve({ remove: vi.fn() })
    })

    const pending = capacitorPlatform.scanQrCode()
    await flush()
    expect(listenerCb).toBeDefined()
    listenerCb!({ barcodes: [{ rawValue: 'gugu://contact/123' }] })
    await expect(pending).resolves.toBe('gugu://contact/123')
  })

  it('still resolves null on an explicit user cancel (cancel path unchanged)', async () => {
    // init never resolves → only the overlay cancel button can settle the promise.
    addListener.mockReturnValue(new Promise(() => {}))

    const pending = capacitorPlatform.scanQrCode()
    await flush()
    const cancelBtn = document.body.querySelector('.gugu-scan-cancel') as HTMLButtonElement | null
    expect(cancelBtn).not.toBeNull()
    cancelBtn!.click()
    await expect(pending).resolves.toBeNull()
  })

  it('renders the English native overlay after resolved-locale sync', async () => {
    await capacitorPlatform.syncResolvedLocale('en-US')
    addListener.mockReturnValue(new Promise(() => {}))

    const pending = capacitorPlatform.scanQrCode()
    await flush()

    expect(document.body.querySelector('.gugu-scan-hint')?.textContent)
      .toBe('Place the QR code inside the frame')
    const cancel = document.body.querySelector('.gugu-scan-cancel') as HTMLButtonElement
    expect(cancel.textContent).toBe('Cancel')
    cancel.click()
    await expect(pending).resolves.toBeNull()
  })
})
