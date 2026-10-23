import type { MessageItem } from '@gugu/core/shared/types/chat'
// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'

const boundary = vi.hoisted(() => ({
  mobile: false,
  read: vi.fn(),
  document: vi.fn(),
  forward: vi.fn(),
  signed: vi.fn(),
  save: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  preview: vi.fn(),
  previewContents: new Map<string, string>(),
}))
vi.mock('@/components/preview/html-preview-registration', () => ({ registerHtmlPreview: boundary.preview }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } } }))
vi.mock('@/hooks/useMobileShell', () => ({ useMobileShell: () => boundary.mobile }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn(async () => ({ error: null })) } }))
vi.mock('@/lib/attachmentBytes', () => ({
  attachmentBytes: boundary.read,
  attachmentResolver: { resolve: boundary.signed },
  openAttachmentInSystemApp: boundary.open,
  sourceKeyOf: (source: { itemId: string; version: number }) => `${source.itemId}@${source.version}`,
}))
vi.mock('@/lib/chatFolder', () => ({ readChatFolderText: boundary.document, rendererFileServiceUrl: () => 'https://files.test' }))
vi.mock('@/lib/download', () => ({ downloadBlob: boundary.save }))
vi.mock('@/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, marketOffers: async () => ({ success: true, data: [] }), groupFileOpener: vi.fn(), setOpenWithDefault: vi.fn() },
}))
vi.mock('@/components/extensionBundle/sharedPackages', () => ({ sharedPackagesOf: async () => new Map(), subscribeSharedPackages: () => () => {} }))

const { GroupAppSlot, WORKSPACE_APP_KIND } = await import('@/components/appSlot/GroupAppSlot')
const { AppPeek } = await import('@/components/appSlot/AppPeek')
const { groupSlotMemory } = await import('@/components/appSlot/groupSlotMemory')
const { installedExtensionsStore } = await import('@/session/renderer/features/extensions/installed-extensions-store')
const { AuthContext } = await import('@/store/auth')
const { appsHere } = await import('@/components/appSlot/appsHere')
const workspace = { id: 'workspace', name: '文件夹', version: '0.2.53', apiVersion: 3, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: '文件夹', opensFiles: { chat: ['.md', '.json'] } }] } }
const candidate = { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: '文件夹', app: { name: '文件夹' }, onlyTab: true, suffix: '.md' }
let harness: ReturnType<typeof createReactHarness>
const checkVisibility = HTMLElement.prototype.checkVisibility
let request = 766300
const detail = (suffix: string) => ({ chatId: 'preview-group', itemId: `file-${suffix}`, name: `report.${suffix}`, typedName: `report.${suffix}`, file: { document: false, contentType: suffix === 'html' ? 'text/html' : suffix === 'mp4' ? 'video/mp4' : 'application/octet-stream', version: 3, size: 1024 }, choice: { kind: 'none' as const } })
const slot = (opener: ReturnType<typeof detail>, supplied = true, extra: { visible?: boolean; message?: MessageItem; tabbed?: boolean; restore?: () => void } = {}) => createElement(AuthContext.Provider, { value: { user: { id: 'viewer' } } as never }, createElement(GroupAppSlot, {
  chatId: opener.chatId, kind: WORKSPACE_APP_KIND, title: '群文件夹', onClose: boundary.close, visible: extra.visible ?? true, tabbed: extra.tabbed, onForward: boundary.forward,
  fileToOpen: { chatId: opener.chatId, itemId: opener.itemId, request: ++request, ...(extra.restore ? { restore: extra.restore } : {}), ...(extra.message ? { message: extra.message } : {}), ...(supplied ? { opener } : {}) },
}))
beforeEach(() => {
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  boundary.mobile = false
  vi.clearAllMocks()
  boundary.previewContents.clear()
  boundary.preview.mockImplementation(async (html: string) => {
    const url = `blob:group-preview-${boundary.previewContents.size}`
    boundary.previewContents.set(url, html)
    return { ok: true, url, update: vi.fn(), release: vi.fn() }
  })
  boundary.signed.mockResolvedValue({ status: 'ready', url: 'https://media.test/signed.mp4' })
  boundary.read.mockResolvedValue({ status: 'ready', blob: { text: async () => '<h1>lane report</h1>', arrayBuffer: async () => new ArrayBuffer(4) } })
  boundary.document.mockResolvedValue({ text: '<h1>live report</h1>' })
  boundary.save.mockResolvedValue(undefined)
  for (const item of [...groupSlotMemory.tabs('preview-group')]) groupSlotMemory.close('preview-group', item)
  groupSlotMemory.setOpened('preview-group', null)
  act(() => installedExtensionsStore.applyList({ extensions: [workspace], invalid: [] } as never))
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
  HTMLElement.prototype.checkVisibility = checkVisibility
  act(() => installedExtensionsStore.applyList({ extensions: [], invalid: [] } as never))
})

describe('unclaimed group files use the message preview from every entry', () => {
  it.each([false, true])('ordinary openWith plays MP4 on the host (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    const file = detail('mp4')
    await harness.render(slot(file))
    await until('the existing video player is ready', () => harness.container.querySelector('video') !== null)
    const video = harness.container.querySelector('video')!
    expect(video.src).toBe('https://media.test/signed.mp4')
    expect(video.controls).toBe(true)
    expect(video.playsInline).toBe(true)
    expect(boundary.signed).toHaveBeenCalledWith({ kind: 'item', itemId: file.itemId, version: 3 })
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.open).not.toHaveBeenCalled()
    const download = harness.container.querySelector('button[aria-label="下载"]')
    expect(download).not.toBeNull()
  })

  it('a file link and an App card resolve HTML through the same host preview', async () => {
    const file = detail('html')
    vi.mocked(appsHere!.groupFileOpener).mockResolvedValue({ success: true, data: file })
    await harness.render(slot(file, false))
    await until('the report HTML is drawn', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    expect(appsHere!.groupFileOpener).toHaveBeenCalledWith({ chatId: file.chatId, itemId: file.itemId })
    expect(harness.container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(boundary.read).toHaveBeenCalledWith({ kind: 'item', itemId: file.itemId, version: 3 })
  })

  it('peek has the same content and download as ordinary openWith', async () => {
    const file = detail('html')
    await harness.render(createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'report-peek', beside: false, onClose: vi.fn() }))
    await until('peek uses the same HTML content', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    expect(harness.container.querySelector('button[aria-label="下载"]')).not.toBeNull()
  })

  it('unsupported exe shows details and downloads only when asked, without opening it', async () => {
    const file = detail('exe')
    await harness.render(slot(file))
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).not.toBeNull()
    expect(harness.container.textContent).toContain('report.exe')
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.signed).not.toHaveBeenCalled()
    expect(harness.container.querySelector('button[aria-label="在系统浏览器打开"]')).toBeNull()
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="下载"]')!.click())
    expect(boundary.save).toHaveBeenCalledWith(expect.anything(), 'report.exe')
    expect(boundary.open).not.toHaveBeenCalled()
  })

  it('a claimed markdown file still opens in the folder App, without fetching a host preview', async () => {
    const file = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    await harness.render(slot(file as never))
    expect(groupSlotMemory.opened(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: file.itemId })
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
    expect(boundary.read).not.toHaveBeenCalled()
  })

  it.each([false, true])('back restores the App a preview was opened from without closing the panel (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    groupSlotMemory.setOpened('preview-group', { kind: 'workspace.main', itemId: 'notes', title: 'notes.md', typedName: 'notes.md', opening: 7663 })
    await harness.render(slot(detail('exe')))
    expect(groupSlotMemory.opened('preview-group')?.kind).toBeNull()
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(groupSlotMemory.opened('preview-group')).toMatchObject({ kind: 'workspace.main', itemId: 'notes' })
    expect(boundary.close).not.toHaveBeenCalled()
  })

  it.each([false, true])('back from the folder preview restores the list and keeps the panel open (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    await harness.render(slot(detail('exe')))
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(groupSlotMemory.opened('preview-group')).toBeNull()
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot"]')).not.toBeNull()
    expect(boundary.close).not.toHaveBeenCalled()
  })

  it('the tabbed binary preview closes only its object, keeping the source tab and one host header', async () => {
    const source = { kind: 'workspace.main', itemId: 'notes', title: 'notes.md', opening: 17401 }
    groupSlotMemory.setOpened('preview-group', source)
    const file = detail('exe')
    await harness.render(slot(file, true, { tabbed: true }))
    expect(harness.container.querySelector('header')).toBeNull()
    const bar = harness.container.querySelector('[data-testid="message-file-preview-tab-bar"]')!
    const close = bar.lastElementChild as HTMLButtonElement
    await act(async () => close.click())
    expect(groupSlotMemory.opened('preview-group')).toBe(source)
    expect(groupSlotMemory.tabs('preview-group').some((item) => item?.itemId === file.itemId)).toBe(false)
    expect(boundary.close).not.toHaveBeenCalled()
  })

  it('a message entry has Close, removes its object and then restores the original message', async () => {
    const restore = vi.fn()
    const file = detail('exe')
    await harness.render(slot(file, true, { tabbed: true, restore }))
    expect(harness.container.querySelector('button[aria-label="返回"]')).toBeNull()
    const close = harness.container.querySelector('[data-testid="message-file-preview-tab-bar"]')!.lastElementChild as HTMLButtonElement
    await act(async () => close.click())
    expect(groupSlotMemory.tabs('preview-group').some((item) => item?.itemId === file.itemId)).toBe(false)
    expect(boundary.close).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('expands and restores a group HTML preview without replacing its page or returning to the folder', async () => {
    const file = detail('html')
    const fileToOpen = { chatId: file.chatId, itemId: file.itemId, request: ++request, opener: file }
    function Preview() {
      const [full, setFull] = useState(false)
      return createElement(AuthContext.Provider, { value: { user: { id: 'viewer' } } as never }, createElement(GroupAppSlot, {
        chatId: file.chatId, kind: WORKSPACE_APP_KIND, title: '群文件夹', onClose: boundary.close,
        fileToOpen, full, onToggleFull: () => setFull((value) => !value),
      }))
    }
    await harness.render(createElement(Preview))
    await until('HTML is ready before expanding', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    const page = harness.container.querySelector('iframe')
    const expand = harness.container.querySelector<HTMLButtonElement>('button[aria-label="面板全屏"]')
    expect(expand).not.toBeNull()
    await act(async () => expand!.click())
    const restore = harness.container.querySelector<HTMLButtonElement>('button[aria-label="还原面板"]')
    expect(restore?.getAttribute('aria-pressed')).toBe('true')
    await act(async () => restore!.click())
    expect(harness.container.querySelector('button[aria-label="面板全屏"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(harness.container.querySelector('iframe')).toBe(page)
    expect(harness.container.querySelectorAll('header')).toHaveLength(1)
    expect(groupSlotMemory.opened(file.chatId)?.itemId).toBe(file.itemId)
    expect(boundary.read).toHaveBeenCalledTimes(1)
    expect(boundary.close).not.toHaveBeenCalled()
  })

  it.each([false, true])('an App arriving during a later file ask never takes over it (later answer first=%s)', async (answerFirst) => {
    const file = detail('exe')
    await harness.render(slot(file))
    let answer!: (value: never) => void
    vi.mocked(appsHere!.groupFileOpener).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const later = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    await harness.render(slot(later as never, false))
    const release = async () => act(async () => answer({ success: true, data: later } as never))
    if (answerFirst) await release()
    const app = { ...workspace, id: 'exe-reader', contributes: { tabs: [{ name: 'main', title: 'Reader', opensFiles: { chat: ['.exe'] } }] } }
    await act(async () => installedExtensionsStore.applyList({ extensions: [workspace, app], invalid: [] } as never))
    expect(groupSlotMemory.opened(file.chatId)?.kind).not.toBe('exe-reader.main')
    if (!answerFirst) await release()
    expect(groupSlotMemory.opened(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: later.itemId })
  })

  it('an enabled App arriving while a preview is open takes over the same file', async () => {
    const file = detail('exe')
    await harness.render(slot(file))
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).not.toBeNull()
    const app = { ...workspace, id: 'exe-reader', contributes: { tabs: [{ name: 'main', title: 'Reader', opensFiles: { chat: ['.exe'] } }] } }
    await act(async () => installedExtensionsStore.applyList({ extensions: [workspace, app], invalid: [] } as never))
    expect(groupSlotMemory.opened(file.chatId)).toMatchObject({ kind: 'exe-reader.main', itemId: file.itemId })
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).toBeNull()
  })

  it('switching a peek to another HTML file never paints the old content under the new filename', async () => {
    const painted: string[] = []
    function Peek({ file }: { file: ReturnType<typeof detail> }) {
      useLayoutEffect(() => { painted.push(boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '') ?? '') }, [file])
      return createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'changing-peek', beside: false, onClose: vi.fn() })
    }
    await harness.render(createElement(Peek, { file: detail('html') }))
    await until('first report loaded', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('lane report') === true)
    boundary.read.mockImplementationOnce(() => new Promise(() => {}))
    await harness.render(createElement(Peek, { file: { ...detail('html'), itemId: 'other-report', name: 'next.html' } }))
    expect(painted.at(-1), 'layout commit happens before the next file load effect').not.toContain('lane report')
  })

  it.each([false, true])('a collaborative HTML document uses the existing live document reader (peek=%s)', async (peek) => {
    const file = { ...detail('html'), file: { ...detail('html').file, document: true } }
    await harness.render(peek ? createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'live-document', beside: false, onClose: vi.fn() }) : slot(file))
    await until('live document rendered', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('live report') === true)
    expect(boundary.document).toHaveBeenCalledWith({ id: file.itemId })
    expect(boundary.signed).not.toHaveBeenCalled()
    expect(boundary.read).not.toHaveBeenCalled()
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="下载"]')!.click())
    expect(boundary.save).toHaveBeenCalledWith(expect.anything(), file.name)
  })

  it('group message previews retain the originating message forward action', async () => {
    const message = { id: 'original-message', content: 'attachment', retracted_at: null } as MessageItem
    await harness.render(slot(detail('exe'), true, { message }))
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="转发"]')!.click())
    expect(boundary.forward).toHaveBeenCalledWith(message)
    expect(boundary.read).not.toHaveBeenCalled()
  })

  it('a retained hidden mobile chat unmounts its native player while keeping the file for return', async () => {
    boundary.mobile = true
    const file = detail('mp4')
    await harness.render(slot(file))
    await until('video started in visible chat', () => harness.container.querySelector('video') !== null)
    await harness.render(slot(file, true, { visible: false }))
    expect(harness.container.querySelector('video')).toBeNull()
    expect(groupSlotMemory.opened('preview-group')?.itemId).toBe('file-mp4')
  })

})
