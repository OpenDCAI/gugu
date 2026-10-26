import type { MessageItem } from '@gugu/core/shared/types/chat'
// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react'
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

const { AppPeek } = await import('@/components/appSlot/AppPeek')
const { ask, chatTabs, shownItem } = await import('./chatTabsHarness')
const { folderItem, isFolderItem } = await import('@/session/renderer/features/chats/chat-tabs/chat-panel-item')
const { chatAlone, closeChatTab, openPanelItem, panelTabsOf, shownPanelTab } = await import('@/session/renderer/features/chats/chat-tabs/chat-layouts')
const { installedExtensionsStore } = await import('@/session/renderer/features/extensions/installed-extensions-store')
const { appsHere } = await import('@/components/appSlot/appsHere')
const workspace = { id: 'workspace', name: '文件夹', version: '0.2.53', apiVersion: 3, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: '文件夹', opensFiles: { chat: ['.md', '.json'] } }] } }
const candidate = { extensionId: 'workspace', tabKind: 'workspace.main', tabTitle: '文件夹', app: { name: '文件夹' }, onlyTab: true, suffix: '.md' }
let harness: ReturnType<typeof createReactHarness>
const checkVisibility = HTMLElement.prototype.checkVisibility
const detail = (suffix: string) => ({ chatId: 'preview-group', itemId: `file-${suffix}`, name: `report.${suffix}`, typedName: `report.${suffix}`, file: { document: false, contentType: suffix === 'html' ? 'text/html' : suffix === 'mp4' ? 'video/mp4' : 'application/octet-stream', version: 3, size: 1024 }, choice: { kind: 'none' as const } })
/** The chat's tabs drawn, then the file asked of it — a link's (no answer in hand: `supplied` false), or with its host's answer. */
const slot = async (opener: ReturnType<typeof detail>, supplied = true, extra: { visible?: boolean; message?: MessageItem; tabbed?: boolean; restore?: () => void; fromPage?: boolean } = {}) => {
  await harness.render(chatTabs({ chatId: opener.chatId, visible: extra.visible ?? true, tabbed: extra.tabbed, mobile: boundary.mobile, onForward: boundary.forward }, 'viewer'))
  ask(opener.chatId, { itemId: opener.itemId, ...(extra.restore ? { restore: extra.restore } : {}), ...(extra.message ? { message: extra.message } : {}), ...(supplied ? { opener: opener as never } : {}), ...(extra.fromPage ? { fromPage: true as const } : {}) })
}
const redraw = (chatId: string, extra: { visible?: boolean } = {}) =>
  harness.render(chatTabs({ chatId, visible: extra.visible ?? true, mobile: boundary.mobile, onForward: boundary.forward }, 'viewer'))
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
  for (const tab of panelTabsOf('preview-group')) closeChatTab('preview-group', tab.tabId)
  act(() => installedExtensionsStore.applyList({ extensions: [workspace], invalid: [] } as never))
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
  HTMLElement.prototype.checkVisibility = checkVisibility
  act(() => installedExtensionsStore.applyList({ extensions: [], invalid: [] } as never))
})

describe('unclaimed group files use the message preview from every entry', () => {
  it('the phone opens its chooser above the App page; cancelling keeps that page and picking preserves its Back link', async () => {
    boundary.mobile = true
    const folder = openPanelItem('preview-group', folderItem())
    const file = { ...detail('md'), choice: { kind: 'choose' as const, suffix: '.md', candidates: [candidate] } }
    await slot(file as never, true, { fromPage: true })
    const chooser = () => document.querySelector('[role="dialog"] [data-testid="group-app-open-with"]')
    expect(chooser()).not.toBeNull()
    expect(harness.container.contains(chooser()), 'the chooser is portalled above the full-screen page').toBe(false)
    await act(async () => window.dispatchEvent(new Event('gugu:native-back')))
    expect(chooser()).toBeNull()
    expect(shownPanelTab('preview-group')?.tabId).toBe(folder)
    ask(file.chatId, { itemId: file.itemId, opener: file as never, fromPage: true })
    await act(async () => document.querySelector<HTMLButtonElement>('[data-open-with="workspace.main"]')!.click())
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: file.itemId })
    act(() => closeChatTab(file.chatId, shownPanelTab(file.chatId)!.tabId))
    expect(shownPanelTab(file.chatId)?.tabId).toBe(folder)
  })

  it.each([false, true])('ordinary openWith plays MP4 on the host (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    const file = detail('mp4')
    await slot(file)
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
    await slot(file, false)
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
    await slot(file)
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
    await slot(file as never)
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: file.itemId })
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
    expect(boundary.read).not.toHaveBeenCalled()
  })

  it.each([false, true])('back restores the App a preview was opened from without closing the panel (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    openPanelItem('preview-group', { kind: 'workspace.main', itemId: 'notes', title: 'notes.md', typedName: 'notes.md' })
    await slot(detail('exe'), true, { fromPage: true })
    expect(shownItem('preview-group')?.kind).toBeNull()
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(shownItem('preview-group')).toMatchObject({ kind: 'workspace.main', itemId: 'notes' })
    expect(chatAlone('preview-group')).toBe(false)
  })

  it.each([false, true])('back from the folder preview restores the list and keeps the panel open (mobile=%s)', async (mobile) => {
    boundary.mobile = mobile
    const folder = openPanelItem('preview-group', folderItem())
    await slot(detail('exe'), true, { fromPage: true })
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(shownPanelTab('preview-group')?.tabId).toBe(folder)
    expect(isFolderItem(shownItem('preview-group'))).toBe(true)
    expect(harness.container.querySelector('[data-testid="message-file-preview-panel"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="group-app-slot"]')).not.toBeNull()
  })

  it('the tabbed binary preview closes only its object, keeping the source tab and one host header', async () => {
    const source = openPanelItem('preview-group', { kind: 'workspace.main', itemId: 'notes', title: 'notes.md' })
    const file = detail('exe')
    await slot(file, true, { tabbed: true, fromPage: true })
    expect(harness.container.querySelector('header')).toBeNull()
    const bar = harness.container.querySelector('[data-testid="message-file-preview-tab-bar"]')!
    const close = bar.lastElementChild as HTMLButtonElement
    await act(async () => close.click())
    expect(shownPanelTab('preview-group')?.tabId).toBe(source)
    expect(panelTabsOf('preview-group').some((tab) => tab.item.itemId === file.itemId)).toBe(false)
  })

  it('a message entry has Close, removes its object and then restores the original message', async () => {
    const restore = vi.fn()
    const file = detail('exe')
    await slot(file, true, { tabbed: true, restore })
    expect(harness.container.querySelector('button[aria-label="返回"]')).toBeNull()
    const close = harness.container.querySelector('[data-testid="message-file-preview-tab-bar"]')!.lastElementChild as HTMLButtonElement
    await act(async () => close.click())
    expect(panelTabsOf('preview-group').some((tab) => tab.item.itemId === file.itemId)).toBe(false)
    expect(chatAlone('preview-group')).toBe(true)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('a phone message preview has Back and closes its tab before restoring the originating topic', async () => {
    boundary.mobile = true
    const restore = vi.fn(() => expect(chatAlone('preview-group')).toBe(true))
    await slot(detail('exe'), true, { restore })
    expect(harness.container.querySelector('button[aria-label="关闭预览"]')).toBeNull()
    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="返回"]')
    expect(back).not.toBeNull()
    await act(async () => back!.click())
    expect(shownItem('preview-group')).toBeNull()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('expands and restores a group HTML preview in a block without replacing its page', async () => {
    const file = detail('html')
    await slot(file, true, { tabbed: true })
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
    expect(harness.container.querySelectorAll('header')).toHaveLength(0)
    expect(shownItem(file.chatId)?.itemId).toBe(file.itemId)
    expect(boundary.read).toHaveBeenCalledTimes(1)
    expect(chatAlone(file.chatId)).toBe(false)
  })

  it('outside a block a group HTML preview has no full switch (no strip to fill)', async () => {
    await slot(detail('html'))
    expect(harness.container.querySelector('button[aria-label="面板全屏"]')).toBeNull()
  })

  it.each([false, true])('an App arriving during a later file ask never takes over it (later answer first=%s)', async (answerFirst) => {
    const file = detail('exe')
    await slot(file)
    let answer!: (value: never) => void
    vi.mocked(appsHere!.groupFileOpener).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const later = { ...detail('md'), choice: { kind: 'one' as const, candidate } }
    ask(later.chatId, { itemId: later.itemId })
    const release = async () => act(async () => answer({ success: true, data: later } as never))
    if (answerFirst) await release()
    const app = { ...workspace, id: 'exe-reader', contributes: { tabs: [{ name: 'main', title: 'Reader', opensFiles: { chat: ['.exe'] } }] } }
    await act(async () => installedExtensionsStore.applyList({ extensions: [workspace, app], invalid: [] } as never))
    expect(shownItem(file.chatId)?.itemId, 'the later ask is not answered by the App arriving').toBe(answerFirst ? later.itemId : file.itemId)
    if (!answerFirst) await release()
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'workspace.main', itemId: later.itemId })
  })

  it('an enabled App arriving while a preview is open takes over the same file', async () => {
    const file = detail('exe')
    await slot(file)
    expect(harness.container.querySelector('[data-preview-kind="unsupported"]')).not.toBeNull()
    const app = { ...workspace, id: 'exe-reader', contributes: { tabs: [{ name: 'main', title: 'Reader', opensFiles: { chat: ['.exe'] } }] } }
    await act(async () => installedExtensionsStore.applyList({ extensions: [workspace, app], invalid: [] } as never))
    expect(shownItem(file.chatId)).toMatchObject({ kind: 'exe-reader.main', itemId: file.itemId })
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
    if (peek) await harness.render(createElement(AppPeek, { target: { kind: 'chat', detail: file }, slotKey: 'live-document', beside: false, onClose: vi.fn() }))
    else await slot(file)
    await until('live document rendered', () => boundary.previewContents.get(harness.container.querySelector('iframe')?.getAttribute('src') ?? '')?.includes('live report') === true)
    expect(boundary.document).toHaveBeenCalledWith({ id: file.itemId })
    expect(boundary.signed).not.toHaveBeenCalled()
    expect(boundary.read).not.toHaveBeenCalled()
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="下载"]')!.click())
    expect(boundary.save).toHaveBeenCalledWith(expect.anything(), file.name)
  })

  it('group message previews retain the originating message forward action', async () => {
    const message = { id: 'original-message', content: 'attachment', retracted_at: null } as MessageItem
    await slot(detail('exe'), true, { message })
    await act(async () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="转发"]')!.click())
    expect(boundary.forward).toHaveBeenCalledWith(message)
    expect(boundary.read).not.toHaveBeenCalled()
  })

  it('a retained hidden mobile chat unmounts its native player while keeping the file for return', async () => {
    boundary.mobile = true
    const file = detail('mp4')
    await slot(file)
    await until('video started in visible chat', () => harness.container.querySelector('video') !== null)
    await redraw(file.chatId, { visible: false })
    expect(harness.container.querySelector('video')).toBeNull()
    expect(shownItem('preview-group')?.itemId).toBe('file-mp4')
  })

})
