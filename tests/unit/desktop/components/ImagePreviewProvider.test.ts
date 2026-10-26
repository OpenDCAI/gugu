// @vitest-environment jsdom
// #6607 查看器宿主:PhotoSwipe 挂上咕咕的工具栏、手机形态、下载/复制、安卓返回键与按键不外泄。
// 手势与开合过渡是 PhotoSwipe 的本职,产品面实测在 mac1(见 #6607);这里钉住咕咕自己加的那一层。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImagePreviewProvider } from '../../../../apps/desktop/src/components/ImagePreviewProvider'
import { openImageViewer } from '../../../../apps/desktop/src/lib/imageViewer'
import { isSheetOpen } from '../../../../apps/desktop/src/components/ui/sheetStack'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { Dialog } from '../../../../apps/desktop/src/components/ui/Dialog'
import { Sheet } from '../../../../apps/desktop/src/components/ui/Sheet'
import type { ToastContextValue } from '../../../../apps/desktop/src/components/toastContext'
import * as platformMock from '../../../support/capacitorPlatformTestDouble'
import { anchorDownload } from '../../../../apps/desktop/src/platform/anchorDownload'
import {
  clickElement,
  createNode,
  createReactHarness,
  renderWithAppProviders,
  waitForCondition,
} from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

const IMAGES = [
  { url: 'https://example.test/one.png', alt: 'one' },
  { url: 'https://example.test/two.png', alt: 'two' },
]
const byTestId = (id: string) => document.body.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  platformMock.platform.kind = 'desktop'
  // 桌面的 saveFile 就是这一份 a[download](安卓壳的另走原生,见 shareWithApps.test)。
  Object.assign(platformMock.platform, { saveFile: anchorDownload })
  // jsdom 没有 matchMedia;按「减少动态效果」回答,PhotoSwipe 的开合就不走动画,开关立即落定。
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => {
  harness.cleanup()
  // stubGlobal/defineProperty 补丁不会被 restoreAllMocks 撤销,显式清掉,防跨用例污染
  vi.unstubAllGlobals()
  delete (URL as Partial<typeof URL>).createObjectURL
  delete (URL as Partial<typeof URL>).revokeObjectURL
  delete (navigator as { clipboard?: unknown }).clipboard
  delete (window as NativeBackWindow).__guguNativeBackHandled
})

type NativeBackWindow = Window & { __guguNativeBackHandled?: boolean }
const nativeBackHandled = () => (window as NativeBackWindow).__guguNativeBackHandled === true

async function openViewer(options: { toast?: ToastContextValue['toast'] } = {}) {
  await renderWithAppProviders(harness, createNode(ImagePreviewProvider, null), options)
  await act(async () => openImageViewer(IMAGES, 0))
  await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewClose) !== null, 'viewer toolbar never mounted')
}

describe('ImagePreviewProvider', () => {
  it('打开后是一个 aria-modal 的对话层,带计数;左右键翻页', async () => {
    await openViewer()
    const overlay = byTestId(AUTOMATION_TEST_IDS.imagePreviewOverlay)!
    expect(overlay.getAttribute('role')).toBe('dialog')
    expect(overlay.getAttribute('aria-modal')).toBe('true')
    expect(overlay.textContent).toContain('1 / 2')
    expect(byTestId(AUTOMATION_TEST_IDS.imagePreviewPrev)).toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await waitForCondition(() => overlay.textContent?.includes('2 / 2') ?? false, 'ArrowRight did not advance')
    expect(byTestId(AUTOMATION_TEST_IDS.imagePreviewNext)).toBeNull()
    expect(byTestId(AUTOMATION_TEST_IDS.imagePreviewPrev)).not.toBeNull()
  })

  it('手机形态:左上是返回(先于占位),操作钮都是触控尺寸,没有左右箭头', async () => {
    platformMock.platform.kind = 'capacitor'
    await openViewer()
    const close = byTestId(AUTOMATION_TEST_IDS.imagePreviewClose)!
    const bar = close.parentElement!
    expect(bar.firstElementChild).toBe(close)
    for (const id of [AUTOMATION_TEST_IDS.imagePreviewClose, AUTOMATION_TEST_IDS.imagePreviewCopy, AUTOMATION_TEST_IDS.imagePreviewDownload]) {
      expect(byTestId(id)!.hasAttribute('data-mobile')).toBe(true)
    }
    expect(byTestId(AUTOMATION_TEST_IDS.imagePreviewNext)).toBeNull()
  })

  it('关闭后整层从 DOM 里拿掉', async () => {
    await openViewer()
    await clickElement(byTestId(AUTOMATION_TEST_IDS.imagePreviewClose)!)
    await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewOverlay) === null, 'overlay was not removed')
    expect(byTestId(AUTOMATION_TEST_IDS.imagePreviewClose)).toBeNull()
  })

  // @@@native-back-bridge:安卓壳把返回键翻成这句 JS(MainActivity.java 的 dispatchBackToWeb),再读 handled。
  // 查看器与 Sheet 同一个栈:返回键只关栈顶的查看器,压在下面的 Sheet 不动;页面那一层按 isSheetOpen() 让路
  // (由 sheetNativeBack.test 钉住)。
  it('安卓返回键只关查看器,压在下面的 Sheet 不跟着关', async () => {
    const sheetClose = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(ImagePreviewProvider, null, createNode(Sheet, { onClose: sheetClose, ariaLabel: 'history', children: 'history body' })),
    )
    await act(async () => openImageViewer(IMAGES, 0))
    await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewClose) !== null, 'viewer toolbar never mounted')
    expect(isSheetOpen()).toBe(true)
    const handled = await act(async () => {
      (window as NativeBackWindow).__guguNativeBackHandled = false
      window.dispatchEvent(new CustomEvent('gugu:native-back'))
      return nativeBackHandled()
    })
    expect(handled).toBe(true)
    await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewOverlay) === null, 'native back did not close the viewer')
    expect(sheetClose).not.toHaveBeenCalled()
    expect(isSheetOpen()).toBe(true)
  })

  // code review 找出的回归:会话页扩展详情(Base UI 对话框)里 README 的图点开后,一下 Esc 把对话框也关了。
  it('Esc 只关查看器,不连带关掉压在它下面的 Base UI 对话框', async () => {
    const onOpenChange = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(
        ImagePreviewProvider,
        null,
        createNode(Dialog.Root, { open: true, onOpenChange }, createNode(Dialog.Portal, null, createNode(Dialog.Popup, null, 'extension detail'))),
      ),
    )
    await act(async () => openImageViewer(IMAGES, 0))
    await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewClose) !== null, 'viewer toolbar never mounted')
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewOverlay) === null, 'Escape did not close the viewer')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('Esc 关查看器,不冒泡到底下的页面(否则顺手把底下的面板也关了)', async () => {
    await openViewer()
    const pageBehind = vi.fn()
    window.addEventListener('keydown', pageBehind)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    window.removeEventListener('keydown', pageBehind)
    expect(pageBehind).not.toHaveBeenCalled()
    await waitForCondition(() => byTestId(AUTOMATION_TEST_IDS.imagePreviewOverlay) === null, 'Escape did not close the viewer')
  })

  // @@@1892 - 跨域 URL 上 <a download> 会被 Chromium 忽略并整窗导航到裸图,
  // 下载必须先取 blob 换成同源 object URL 再点击。
  it('downloads via a blob object URL instead of navigating to the remote URL', async () => {
    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => pngBlob }))
    vi.stubGlobal('fetch', fetchMock)
    const createObjectURL = vi.fn(() => 'blob:mock-download')
    const revokeObjectURL = vi.fn()
    // jsdom 的 URL 没有 createObjectURL/revokeObjectURL,直接补在真 URL 上
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true })
    let clickedAnchor: { href: string; download: string } | null = null
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchor = { href: this.getAttribute('href') ?? '', download: this.download }
    })
    await openViewer()
    await clickElement(byTestId(AUTOMATION_TEST_IDS.imagePreviewDownload)!)
    await waitForCondition(() => clickedAnchor !== null, 'download anchor was never clicked')
    expect(clickedAnchor).toEqual({ href: 'blob:mock-download', download: 'one' })
    // credentials: 'include' 配 storage 的 Access-Control-Allow-Origin: * 会直接 CORS 失败
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/one.png')
    // revoke 是延迟的(给非 Chromium 引擎解引用 blob URL 的时间),条件等待而非立即断言
    await waitForCondition(() => revokeObjectURL.mock.calls.length > 0, 'object URL was never revoked')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-download')
  })

  it('shows the sanitized download cause instead of a generic failure', async () => {
    const error = new Error('Storage access denied /Users/test/private sk-synthetic-secret\nstack detail')
    const toast = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error))
    await openViewer({ toast })
    await clickElement(byTestId(AUTOMATION_TEST_IDS.imagePreviewDownload)!)
    expect(toast).toHaveBeenCalledWith('无法下载图片', 'error', 'Storage access denied [path] [redacted token]')
  })

  // @@@1892 - Promise 值的 ClipboardItem 要 Chrome 122+,产品 Electron 28 = Chromium 120,
  // 复制必须先 await 拿到 Blob 再构造 ClipboardItem。
  it.each([false, true])('awaits PNG bytes before copying and reports clipboard refusals (denied=%s)', async (denied) => {
    const pngBlob = new Blob(['png-bytes'], { type: 'image/png' })
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => pngBlob }))
    vi.stubGlobal('fetch', fetchMock)
    const constructedValues: unknown[] = []
    class FakeClipboardItem {
      constructor(items: Record<string, unknown>) {
        constructedValues.push(items['image/png'])
      }
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    const write = vi.fn(async () => { if (denied) throw new Error('Clipboard permission denied') })
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true })
    vi.stubGlobal('isSecureContext', true)
    const toast = vi.fn()
    await openViewer({ toast })
    await clickElement(byTestId(AUTOMATION_TEST_IDS.imagePreviewCopy)!)
    await waitForCondition(() => write.mock.calls.length > 0, 'clipboard.write was never called')
    expect(constructedValues).toHaveLength(1)
    expect(constructedValues[0]).toBe(pngBlob)
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/one.png')
    await waitForCondition(() => toast.mock.calls.length > 0, 'success toast was never shown')
    if (denied) expect(toast).toHaveBeenCalledWith('无法复制图片', 'error', 'Clipboard permission denied')
    else expect(toast).toHaveBeenCalledWith('图片已复制', 'success')
  })
})
