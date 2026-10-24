// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageActionItem } from '@/components/chat/messageActionItems'
import type { PreviewFile } from '@/components/chat/useMessageFilePreview'

// 字节、链接、交给系统应用都经 lib/attachmentBytes(一个入口);这里把它换掉,判的是预览自己的状态机。
const bytesMocks = vi.hoisted(() => ({
  attachmentBytes: vi.fn(), downloadAttachment: vi.fn(),
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
// Every group item uses the same opener; the message does not decide who claims it again.
const appMocks = vi.hoisted(() => ({ openResource: vi.fn() }))
vi.mock('@/lib/guguLinks', () => ({ openLinkTarget: appMocks.openResource }))
vi.mock('@/lib/attachmentBytes', () => bytesMocks)
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
const downloadMocks = vi.hoisted(() => ({ downloadBlob: vi.fn() }))
vi.mock('@/lib/download', () => downloadMocks)
vi.mock('@/components/chat/MessageFilePreviewPanel', () => ({
  MessageFilePreviewPanel: ({ content, actions, onClose, onOpenExternal }: { content: string | ArrayBuffer | null; actions: MessageActionItem[]; onClose: () => void; onOpenExternal: () => void }) =>
    React.createElement('div', null,
      React.createElement('output', { 'data-testid': 'preview-content' }, typeof content === 'string' ? content : ''),
      ...actions.map((item) => React.createElement('button', { key: item.key, 'data-testid': `preview-${item.key}`, disabled: item.disabled, onClick: item.onSelect })),
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
  let openPreview: ((file: PreviewFile, message?: MessageItem, restore?: () => void) => void) | undefined
  let closePreview: (() => void) | undefined
  const closeRightSurfaces = vi.fn(), onForward = vi.fn()
  let mobile = false
  let visible = true

  function Probe() {
    const preview = useMessageFilePreview({
      mobile,
      visible,
      closeRightSurfaces, onForward,
      toast: vi.fn(),
      downloadFailed: 'download failed',
    })
    openPreview = preview.open
    closePreview = preview.close
    return preview.panel
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    bytesMocks.downloadAttachment.mockResolvedValue(undefined)
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
    ['a group item', { kind: 'item', itemId: 'item-1', version: 2 }, true],
    ['an old URL attachment', { kind: 'url', url: 'https://files.test/deck.pptx' }, false],
  ] as const)('%s: uses the shared group opener = %s', async (_label, source, toApp) => {
    appMocks.openResource.mockResolvedValue(undefined)
    bytesMocks.attachmentBytes.mockResolvedValue(bytesOf(async () => ''))
    const deck: PreviewFile = { kind: 'file', fileName: '今晚车道进展.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', sizeBytes: 9, source }
    await act(async () => { root.render(React.createElement(Probe)) })
    await act(async () => { openPreview?.(deck) })
    expect(appMocks.openResource).toHaveBeenCalledTimes(toApp ? 1 : 0)
    if (toApp) expect(appMocks.openResource).toHaveBeenCalledWith({ kind: 'file', itemId: 'item-1' }, { message: undefined, restore: expect.any(Function) })
    expect(closeRightSurfaces).toHaveBeenCalledTimes(toApp ? 0 : 1)
    expect(container.querySelector('[data-testid="preview-content"]') !== null).toBe(!toApp)
  })

  it('passes the originating message into the shared group-file route', async () => {
    appMocks.openResource.mockResolvedValue(undefined)
    const message = { id: 'origin', content: 'attachment' } as MessageItem
    const attachment = { ...file, source: { kind: 'item' as const, itemId: 'group-file', version: 1 } }
    await act(async () => { root.render(React.createElement(Probe)) })
    const restore = vi.fn()
    await act(async () => { openPreview?.(attachment, message, restore) })
    expect(appMocks.openResource).toHaveBeenCalledWith({ kind: 'file', itemId: 'group-file' }, { message, restore })
    expect(restore).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()
  })

  it('forwards the originating message without downloading or closing the preview; originless previews offer download only', async () => {
    bytesMocks.attachmentBytes.mockResolvedValue(bytesOf(async () => 'file'))
    const message = { id: 'origin', content: 'attachment', retracted_at: null } as MessageItem
    await act(async () => { root.render(React.createElement(Probe)); })
    await act(async () => { openPreview?.(file, message) })
    await act(async () => { (container.querySelector('[data-testid="preview-forward"]') as HTMLButtonElement).click() })
    expect(onForward).toHaveBeenCalledWith(message)
    expect(downloadMocks.downloadBlob).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    await act(async () => { (container.querySelector('[data-testid="preview-download"]') as HTMLButtonElement).click() })
    expect(downloadMocks.downloadBlob).toHaveBeenCalledWith(expect.anything(), file.fileName)
    await act(async () => { openPreview?.(file) })
    expect(container.querySelector('[data-testid="preview-forward"]')).toBeNull()
    expect(container.querySelector('[data-testid="preview-download"]')).not.toBeNull()
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

  it('shows unsupported file details without executing it or fetching its bytes', async () => {
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

    expect(bytesMocks.openAttachmentInSystemApp).not.toHaveBeenCalled()
    expect(bytesMocks.attachmentBytes).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="preview-content"]')).not.toBeNull()
    expect(closeRightSurfaces).toHaveBeenCalledTimes(1)
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

    await act(async () => { openPreview?.(file, undefined, restore); await Promise.resolve() })
    expect(closeRightSurfaces).toHaveBeenCalledTimes(1)
    await act(async () => { (container.querySelector('[data-testid="preview-close"]') as HTMLElement).click() })
    expect(restore).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="preview-content"]')).toBeNull()

    await act(async () => { openPreview?.(file, undefined, restore); await Promise.resolve() })
    await act(async () => { closePreview?.() })
    expect(restore).toHaveBeenCalledTimes(1)

    // 没给 restore 的(主线打开)点 × 也不会凭空还原什么。
    await act(async () => { openPreview?.(file); await Promise.resolve() })
    await act(async () => { (container.querySelector('[data-testid="preview-close"]') as HTMLElement).click() })
    expect(restore).toHaveBeenCalledTimes(1)
  })
})
