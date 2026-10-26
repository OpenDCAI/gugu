// @vitest-environment jsdom
import type { App, BrowserWindow, ContextMenuParams, WebContents, WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerFileViewerMenus } from '../../../apps/desktop/electron/file-viewer-context-menu'
import { captureEditableContext } from '../../../apps/desktop/electron/editable-context-menu'
import type { ContentMenuEntry } from '@/session/shared/content-context-menu'
import { CONTENT_MENU_EVENT } from '@gugu/session-shared/content-menu'

const showMenu = vi.hoisted(() => vi.fn())
vi.mock('../../../apps/desktop/electron/content-context-menu', () => ({ showContentContextMenu: showMenu }))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (contents: { owner: BrowserWindow }) => contents.owner },
  clipboard: {},
}))
const labels = { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', quoteSelection: 'Quote Selection', quoteFile: 'Quote File' }
const originalHitTest = document.elementFromPoint
afterEach(() => {
  document.body.replaceChildren()
  document.elementFromPoint = originalHitTest
  getSelection()?.removeAllRanges()
  showMenu.mockReset()
})

function source() {
  const target = document.createElement('input'), other = document.createElement('input')
  document.body.append(target, other)
  target.value = 'alpha beta gamma'
  target.focus()
  target.setSelectionRange(6, 10, 'forward')
  document.elementFromPoint = () => target
  const frame = { isDestroyed: () => false, executeJavaScript: vi.fn(async (script: string) => Function(`return ${script}`)()) } as unknown as WebFrameMain
  const paste = vi.fn(() => {
    expect(document.activeElement).toBe(target)
    expect([target.selectionStart, target.selectionEnd]).toEqual([6, 10])
  })
  const contents = { mainFrame: frame, isDestroyed: () => false, focus: vi.fn(), paste } as unknown as WebContents
  Object.assign(contents, { owner: { webContents: contents } })
  return { target, other, frame, contents, paste }
}

describe('editable content menus', () => {
  it('opens the shared menu for an unmarked input and restores its captured selection before host paste', async () => {
    const { target, contents, frame, other, paste } = source()
    const undo = vi.fn()
    const nativeUndo = vi.fn()
    Object.assign(contents, { undo: nativeUndo })
    target.addEventListener(CONTENT_MENU_EVENT, event => {
      if ((event as CustomEvent).detail.action === 'snapshot') (event as CustomEvent).detail.editorHistory = { undo: true, redo: false }
      else {
        expect(document.activeElement).toBe(target)
        undo()
        event.preventDefault()
      }
    })
    const opened = Promise.withResolvers<{ items: ContentMenuEntry[]; close: () => void }>()
    showMenu.mockImplementation((items: ContentMenuEntry[], _position: unknown, close: () => void) => opened.resolve({ items, close }))
    let created!: (event: unknown, contents: WebContents) => void
    let contextMenu!: (event: unknown, params: ContextMenuParams) => void
    Object.assign(contents, { on: (_event: string, listener: typeof contextMenu) => { contextMenu = listener } })
    registerFileViewerMenus({ on: (_event: string, listener: typeof created) => { created = listener } } as unknown as App, () => labels, error => { throw error }, () => true)
    created({}, contents)
    contextMenu({}, { frame, x: 10, y: 20, isEditable: true, selectionText: 'beta', editFlags: { canUndo: false, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: false } } as ContextMenuParams)
    const { items, close } = await opened.promise
    const edits = items.filter(item => item.type !== 'separator')
    expect(edits.map(item => item.id)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    expect(edits.find(item => item.id === 'undo')?.enabled).toBe(true)
    expect(edits.find(item => item.id === 'redo')?.enabled).toBe(false)
    other.focus()
    await edits.find(item => item.id === 'undo')?.click?.()
    expect(undo).toHaveBeenCalledOnce()
    expect(nativeUndo).not.toHaveBeenCalled()
    other.focus()
    await edits.find(item => item.id === 'paste')?.click?.()
    expect(paste).toHaveBeenCalledOnce()
    close()
  })

  it('focuses the embedding webview before restoring and editing a guest frame', async () => {
    const { contents, frame, other, paste } = source()
    const view = document.createElement('webview')
    const order: string[] = []
    Object.assign(view, { getWebContentsId: () => 42, focus: () => order.push('guest-frame-focus') })
    document.body.append(view)
    Object.assign(contents, {
      id: 42,
      hostWebContents: { mainFrame: frame },
      paste: () => { order.push('paste'); paste() },
    })
    const captured = await captureEditableContext(contents, frame, vi.fn())
    other.focus()
    await captured.run('paste')
    expect(order).toEqual(['guest-frame-focus', 'paste'])
    expect(contents.focus).not.toHaveBeenCalled()
    captured.close()
  })

  it('does not edit a different field after the original target is removed', async () => {
    const { target, other, frame, contents, paste } = source()
    const captured = await captureEditableContext(contents, frame, vi.fn())
    target.remove()
    other.focus()
    await expect(captured.run('paste')).rejects.toThrow('target was removed')
    expect(paste).not.toHaveBeenCalled()
    captured.close()
  })
})
