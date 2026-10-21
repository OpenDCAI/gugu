// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewFile } from '@/components/chat/useMessageFilePreview'

// 字节、链接、交给系统应用都经 lib/attachmentBytes(一个入口);这里把它换掉,判的是预览自己的状态机。
const downloadMocks = vi.hoisted(() => ({ downloadBlob: vi.fn() }))
const bytesMocks = vi.hoisted(() => ({
  attachmentBytes: vi.fn(),
  attachmentResolver: { resolve: vi.fn(), forget: vi.fn() },
  openAttachmentInSystemApp: vi.fn(),
  sourceKeyOf: (source: { kind: string; url?: string }) => `${source.kind}:${source.url ?? ''}`,
}))
const bytesOf = (text: () => Promise<string>) => ({ status: 'ready', blob: { text, arrayBuffer: async () => new ArrayBuffer(0) } })

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
}))
// 群文件夹里的、这台设备上有 App 认领的文件:交给 openGroupFile(链接走的那条路);谁认领由 chatClaimantHere 答。
const appMocks = vi.hoisted(() => ({ openGroupFile: vi.fn(), chatClaimantHere: vi.fn() }))
vi.mock('@/components/markdown/fileLinks', () => ({ openGroupFile: appMocks.openGroupFile }))
vi.mock('@/components/markdown/chatClaimant', () => ({ chatClaimantHere: appMocks.chatClaimantHere }))
vi.mock('@/lib/download', () => downloadMocks)
vi.mock('@/lib/attachmentBytes', () => bytesMocks)
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({
  MessageFilePreviewPanel: ({ content, onClose, onOpenExternal }: { content: string | ArrayBuffer | null; onClose: () => void; onOpenExternal: () => void }) =>
    React.createElement('div', null,
      React.createElement('output', { 'data-testid': 'preview-content' }, typeof content === 'string' ? content : ''),
      React.createElement('button', { 'data-testid': 'preview-close', onClick: onClose }),
      React.createElement('button', { 'data-testid': 'preview-external', onClick: onOpenExternal })),
}))

const { useMessageFilePreview } = await import('@/components/chat/useMessageFilePreview')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

const file: PreviewFile = {
  kind: 'file',
  fileName: 'same-file.txt',
  mimeType: 'text/plain',
  sizeBytes: 12,
  source: { kind: 'url', url: 'https://files.test/same-file.txt' },
}

describe('useMessageFilePreview', () => {
  let container: HTMLDivElement
  let root: Root
  let openPreview: ((file: PreviewFile, restore?: () => void) => void) | undefined
  let closePreview: (() => void) | undefined
  const closeRightSurfaces = vi.fn()
  let mobile = false
  let visible = true

  function Probe() {
    const preview = useMessageFilePreview({
      mobile,
      visible,
      closeRightSurfaces,
      toast: vi.fn(),
      downloadFailed: 'download failed',
    })
    openPreview = preview.open
    closePreview = preview.close
    return preview.panel
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    bytesMocks.attachmentResolver.resolve.mockResolvedValue({ status: 'ready', url: 'https://cdn.test/signed', thumbUrl: null, sha256: null, width: null, height: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    mobile = false
    visible = true
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([
    ['an item an App here claims', { kind: 'item', itemId: 'item-1', version: 2 }, true, true],
    ['an item no App here claims', { kind: 'item', itemId: 'item-1', version: 2 }, false, false],
    ['an old attachment an App would claim', { kind: 'url', url: 'https://files.test/deck.pptx' }, true, false],
  ] as const)('%s: handed to its App = %s', async (_label, source, claimed, toApp) => {
    appMocks.chatClaimantHere.mockReturnValue(claimed ? { extensionId: 'office', suffix: '.pptx' } : null)
    appMocks.openGroupFile.mockResolvedValue(true)
    bytesMocks.attachmentBytes.mockResolvedValue(bytesOf(async () => ''))
    const deck: PreviewFile = { kind: 'file', fileName: '今晚车道进展.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sizeBytes: 9, source }
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.(deck) })
    expect(appMocks.openGroupFile).toHaveBeenCalledTimes(toApp ? 1 : 0)
    if (toApp) expect(appMocks.openGroupFile).toHaveBeenCalledWith('item-1')
    expect(closeRightSurfaces).toHaveBeenCalledTimes(toApp ? 0 : 1)
    expect(container.querySelector('[data-testid="preview-content"]') !== null).toBe(!toApp)
  })

  it('opens HTML through the cached system handoff instead of a browser tab or Downloads', async () => {
    bytesMocks.attachmentBytes.mockResolvedValue(bytesOf(async () => '<h1>page</h1>'))
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    bytesMocks.openAttachmentInSystemApp.mockResolvedValue(undefined)
    const html = { ...file, fileName: 'report.html', mimeType: 'application/octet-stream' }
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.(html) })
    await act(async () => { (container.querySelector('[data-testid="preview-external"]') as HTMLButtonElement).click() })
    expect(bytesMocks.openAttachmentInSystemApp).toHaveBeenCalledWith(html.source, html.fileName)
    expect(downloadMocks.downloadBlob).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
    windowOpen.mockRestore()
  })

  it.each([
    ['report', 'report.html'],
    ['report.txt', 'report.txt.html'],
    ['report.HTM', 'report.HTM'],
  ])('opens MIME-declared HTML named %s with an HTML extension', async (fileName, expectedName) => {
    bytesMocks.attachmentBytes.mockResolvedValue(bytesOf(async () => '<h1>page</h1>'))
    bytesMocks.openAttachmentInSystemApp.mockResolvedValue(undefined)
    const html = { ...file, fileName, mimeType: 'text/html' }
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.(html) })
    await act(async () => { (container.querySelector('[data-testid="preview-external"]') as HTMLButtonElement).click() })
    expect(bytesMocks.openAttachmentInSystemApp).toHaveBeenCalledWith(html.source, expectedName)
  })

  it('does not let an old request overwrite a newer request for the same file', async () => {
    const stale = deferred<string>()
    const fresh = deferred<string>()
    bytesMocks.attachmentBytes
      .mockResolvedValueOnce(bytesOf(() => stale.promise))
      .mockResolvedValueOnce(bytesOf(() => fresh.promise))

    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => {
      openPreview?.(file)
      await Promise.resolve()
    })
    await act(async () => {
      openPreview?.(file)
      await Promise.resolve()
    })

    await act(async () => {
      fresh.resolve('fresh content')
      await fresh.promise
    })
    expect(container.querySelector('[data-testid="preview-content"]')?.textContent).toBe('fresh content')

    await act(async () => {
      stale.resolve('stale content')
      await stale.promise
    })
    expect(container.querySelector('[data-testid="preview-content"]')?.textContent).toBe('fresh content')
  })

  it('opens unsupported files in the system app without mounting or fetching a preview', async () => {
    bytesMocks.openAttachmentInSystemApp.mockResolvedValue(undefined)
    const unsupported: PreviewFile = {
      kind: 'file',
      fileName: 'proof.rtf',
      mimeType: 'application/rtf',
      sizeBytes: 77,
      source: { kind: 'url', url: 'https://files.test/proof.rtf' },
    }

    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => {
      openPreview?.(unsupported)
      await Promise.resolve()
    })

    expect(bytesMocks.openAttachmentInSystemApp).toHaveBeenCalledWith(unsupported.source, unsupported.fileName)
    expect(bytesMocks.attachmentBytes).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
    // 交给系统应用的文件不占右栏 ⇒ 不许把右栏(比如话题分栏)关掉。反例在下一格:可预览的文件确实会关。
    expect(closeRightSurfaces).not.toHaveBeenCalled()
  })

  // 手机上点视频要能直接播(#6682):进应用内预览、由 <video> 按需取签好的链接,❌ 整段读进内存,❌ 交给系统应用。
  it('previews playable videos in place from the signed link without fetching the whole file', async () => {
    bytesMocks.attachmentResolver.resolve.mockResolvedValue({ status: 'ready', url: 'https://cdn.test/promo?auth_key=1', thumbUrl: null, sha256: null, width: null, height: null })
    const video: PreviewFile = { kind: 'file', fileName: 'promo.mp4', mimeType: '', sizeBytes: 9_000_000, source: { kind: 'url', url: 'https://files.test/promo.mp4' } }

    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.(video); await Promise.resolve() })

    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(bytesMocks.attachmentResolver.resolve).toHaveBeenCalledWith(video.source)
    expect(bytesMocks.attachmentBytes).not.toHaveBeenCalled()
    expect(bytesMocks.openAttachmentInSystemApp).not.toHaveBeenCalled()
  })

  // 手机上预览盖满整页:安卓返回键先关它,❌ 退回列表时预览还挂着(视频会在看不见的地方接着出声)。
  it('closes the mobile preview on Android back before the page underneath moves', async () => {
    mobile = true
    const { isSheetOpen, NATIVE_BACK_EVENT } = await import('@/components/ui/sheetStack')
    bytesMocks.attachmentResolver.resolve.mockResolvedValue({ status: 'ready', url: 'https://cdn.test/promo', thumbUrl: null, sha256: null, width: null, height: null })
    const video: PreviewFile = { kind: 'file', fileName: 'promo.mp4', mimeType: 'video/mp4', sizeBytes: 1, source: { kind: 'url', url: 'https://files.test/promo.mp4' } }
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.(video); await Promise.resolve() })
    expect(isSheetOpen()).toBe(true)

    const state = window as Window & { __guguNativeBackHandled?: boolean }
    state.__guguNativeBackHandled = false
    await act(async () => { window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT)) })
    expect(state.__guguNativeBackHandled).toBe(true)
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
    expect(isSheetOpen()).toBe(false)
  })

  // 聊天页只是隐藏不卸载:退回列表 / 换 tab 时预览要跟着关,否则它吃掉下一次返回键、视频在后台出声。
  it('closes the mobile preview when its chat page is hidden', async () => {
    mobile = true
    const { isSheetOpen } = await import('@/components/ui/sheetStack')
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.({ ...file, fileName: 'promo.mp4', mimeType: 'video/mp4' }); await Promise.resolve() })
    expect(isSheetOpen()).toBe(true)

    visible = false
    await act(async () => { root.render(React.createElement(Probe)) })
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
    expect(isSheetOpen()).toBe(false)
  })

  it('leaves Android back to the page on desktop-width layouts', async () => {
    const { isSheetOpen } = await import('@/components/ui/sheetStack')
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.({ ...file, fileName: 'promo.mp4', mimeType: 'video/mp4' }); await Promise.resolve() })
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(isSheetOpen()).toBe(false)
  })

  it('classifies only browser-playable video containers as in-app video', async () => {
    const { classifyDocumentPreview } = await import('@/components/chat/documentPreview')
    expect(classifyDocumentPreview({ fileName: 'promo.mp4', mimeType: 'video/mp4' })).toBe('video')
    expect(classifyDocumentPreview({ fileName: 'clip.MOV', mimeType: '' })).toBe('video')
    expect(classifyDocumentPreview({ fileName: 'screen-recording', mimeType: 'video/webm' })).toBe('video')
    // 容器三个宿主都放不了的,照旧交给系统应用。
    expect(classifyDocumentPreview({ fileName: 'old.avi', mimeType: 'video/x-msvideo' })).toBe('unsupported')
    expect(classifyDocumentPreview({ fileName: 'movie.mkv', mimeType: 'video/x-matroska' })).toBe('unsupported')
  })

  // 话题分栏里点开文件:预览顶替分栏;用户点 × 关预览 ⇒ 分栏回来。被别的面板挤掉(程序性 close)⇒ 不回来。
  it('restores what the preview displaced only when the user closes it', async () => {
    bytesMocks.attachmentBytes.mockResolvedValue(bytesOf(async () => 'body'))
    const restore = vi.fn()
    await act(async () => { root.render(React.createElement(Probe)) })

    await act(async () => { openPreview?.(file, restore); await Promise.resolve() })
    expect(closeRightSurfaces).toHaveBeenCalledTimes(1)
    await act(async () => { (container.querySelector('[data-testid="preview-close"]') as HTMLElement).click() })
    expect(restore).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()

    await act(async () => { openPreview?.(file, restore); await Promise.resolve() })
    await act(async () => { closePreview?.() })
    expect(restore).toHaveBeenCalledTimes(1)

    // 没给 restore 的(主线打开)点 × 也不会凭空还原什么。
    await act(async () => { openPreview?.(file); await Promise.resolve() })
    await act(async () => { (container.querySelector('[data-testid="preview-close"]') as HTMLElement).click() })
    expect(restore).toHaveBeenCalledTimes(1)
  })
})
