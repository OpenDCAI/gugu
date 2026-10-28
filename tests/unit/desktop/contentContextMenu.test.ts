import type { BrowserWindow, IpcMain, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerContentContextMenus, showContentContextMenu } from '../../../apps/desktop/electron/content-context-menu'
import { CONTENT_CONTEXT_MENU_ACTION, CONTENT_CONTEXT_MENU_OPEN, type ContentMenuAction } from '@/session/shared/content-context-menu'

function host() {
  const send = vi.fn()
  const webContents = { send, on: vi.fn(), setIgnoreMenuShortcuts: vi.fn(), isDestroyed: () => false } as unknown as WebContents
  return { webContents, send, window: { webContents } as BrowserWindow }
}

function actionHandler() {
  const handle = vi.fn()
  registerContentContextMenus({ handle } as unknown as IpcMain)
  expect(handle.mock.calls[0][0]).toBe(CONTENT_CONTEXT_MENU_ACTION)
  return handle.mock.calls[0][1] as (event: { sender: WebContents }, input: ContentMenuAction) => Promise<void>
}

describe('host content menu actions', () => {
  it('sends only the menu model to its own window and keeps the captured action in the host', () => {
    const first = host(), other = host(), click = vi.fn(), act = actionHandler()
    showContentContextMenu([{ id: 'quote', label: 'Quote file', icon: 'file', click }], { window: first.window, x: 17, y: 28 })
    expect(other.send).not.toHaveBeenCalled()
    const [channel, model] = first.send.mock.calls[0]
    expect(channel).toBe(CONTENT_CONTEXT_MENU_OPEN)
    expect(model).toMatchObject({ x: 17, y: 28, items: [{ id: 'quote', label: 'Quote file', icon: 'file' }] })
    expect(model.items[0]).not.toHaveProperty('click')
    act({ sender: other.webContents }, { requestId: model.requestId, actionId: 'quote' })
    expect(click).not.toHaveBeenCalled()
    act({ sender: first.webContents }, { requestId: model.requestId, actionId: 'quote' })
    act({ sender: first.webContents }, { requestId: model.requestId, actionId: 'quote' })
    expect(click).toHaveBeenCalledOnce()
    expect(first.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false)
  })

  it('rejects stale and disabled actions, and releases a dismissed menu', () => {
    const owner = host(), click = vi.fn(), act = actionHandler()
    const open = (enabled = true) => {
      showContentContextMenu([{ id: 'copy', label: 'Copy', enabled, hotkey: 'Mod+C', click }], { window: owner.window, x: 0, y: 0 })
      return owner.send.mock.lastCall![1].requestId as string
    }
    const old = open(), disabled = open(false)
    act({ sender: owner.webContents }, { requestId: old, actionId: 'copy' })
    act({ sender: owner.webContents }, { requestId: disabled, actionId: 'copy' })
    const dismissed = open()
    act({ sender: owner.webContents }, { requestId: dismissed })
    act({ sender: owner.webContents }, { requestId: dismissed, actionId: 'copy' })
    expect(click).not.toHaveBeenCalled()
  })

  it('keeps the captured source alive until an async action completes and disposes replacements and dismissals', async () => {
    const owner = host(), act = actionHandler(), close = vi.fn(), replacementClose = vi.fn()
    const action = Promise.withResolvers<void>()
    showContentContextMenu([{ id: 'paste', label: 'Paste', click: () => action.promise }], { window: owner.window, x: 0, y: 0 }, close)
    const running = act({ sender: owner.webContents }, { requestId: owner.send.mock.lastCall![1].requestId, actionId: 'paste' })
    expect(close).not.toHaveBeenCalled()
    action.resolve()
    await running
    expect(close).toHaveBeenCalledOnce()
    showContentContextMenu([], { window: owner.window, x: 0, y: 0 }, close)
    showContentContextMenu([], { window: owner.window, x: 0, y: 0 }, replacementClose)
    expect(close).toHaveBeenCalledTimes(2)
    await act({ sender: owner.webContents }, { requestId: owner.send.mock.lastCall![1].requestId })
    expect(replacementClose).toHaveBeenCalledOnce()
  })
})
