// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindFileViewerMenu } from '@/components/preview/file-viewer-menu'
import { type FileViewerMenuRequest } from '@/session/shared/preview/file-viewer-menu'
import { fileViewerMenuTemplate, viewerActionScript, viewerContextScript } from '../../../apps/desktop/electron/file-viewer-context-menu'
import { quoteChatFile } from '@/components/preview/quote-preview-file'
import { composeInChat } from '@/session/shared/extensions/app-send-core'
import { getRendererSession } from '@/lib/sessionPublication'
import { APP_COMPOSE_EVENT } from '@/session/shared/extensions/app-runtime-protocol'

vi.mock('electron', () => ({ BrowserWindow: {}, clipboard: {}, Menu: {} }))
vi.mock('@/session/shared/extensions/app-send-core', () => ({ composeInChat: vi.fn() }))
vi.mock('@/lib/sessionPublication', () => ({ getRendererSession: vi.fn() }))

const labels = { copy: 'Copy', selectAll: 'Select all', quoteSelection: 'Quote selection', quoteFile: 'Quote file', undo: 'Undo', redo: 'Redo', cut: 'Cut', paste: 'Paste' }
const execute = (script: string) => Function(`return ${script}`)()
const originalHitTest = document.elementFromPoint
afterEach(() => {
  document.body.replaceChildren()
  document.elementFromPoint = originalHitTest
  getSelection()?.removeAllRanges()
})

function viewer() {
  const root = document.createElement('section')
  root.innerHTML = '<p id="intro" data-line="3-5">alpha beta gamma</p>'
  document.body.append(root)
  document.elementFromPoint = () => root.firstElementChild
  return root
}

describe('host file viewer menu', () => {
  it('flushes pending composer input in capture before delivering the existing file-reference payload', async () => {
    vi.mocked(getRendererSession).mockReturnValue({ access_token: 'test-token', user: { id: 'owner' } } as ReturnType<typeof getRendererSession>)
    const detail = { chatId: 'chat', text: '> beta', refs: [{ label: 'file.md', link: 'gugu-file://file?v=2' }] }
    vi.mocked(composeInChat).mockResolvedValue(detail)
    const order: string[] = []
    const append = vi.fn((event: Event) => { order.push('append'); return event.eventPhase })
    const flush = () => order.push('flush')
    // The draft receiver may mount before the active composer's capture listener.
    window.addEventListener(APP_COMPOSE_EVENT, append)
    window.addEventListener(APP_COMPOSE_EVENT, flush, true)
    try {
      await quoteChatFile('file', 2, { text: 'beta' })
      expect(order).toEqual(['flush', 'append'])
      expect(append.mock.results[0].value).toBe(Event.BUBBLING_PHASE)
      expect((append.mock.calls[0][0] as CustomEvent).detail).toBe(detail)
    } finally {
      window.removeEventListener(APP_COMPOSE_EVENT, append)
      window.removeEventListener(APP_COMPOSE_EVENT, flush, true)
    }
  })

  it('keeps the source file and editor selection captured before native focus changes', () => {
    const root = viewer()
    const quoteFirst = vi.fn(), quoteSecond = vi.fn()
    let current = { quote: quoteFirst, selection: { text: 'beta', at: { lines: '9' } } }
    const dispose = bindFileViewerMenu(root, () => current, vi.fn())
    const context = execute(viewerContextScript({ x: 20, y: 30, isEditable: false }, 'request', { text: '' }))
    expect(context.selection).toEqual(current.selection)
    current = { quote: quoteSecond, selection: { text: 'other', at: { lines: '2' } } }
    execute(viewerActionScript(context, 'quote-selection'))
    expect(quoteFirst).toHaveBeenCalledWith({ text: 'beta', at: { lines: '9' } })
    expect(quoteSecond).not.toHaveBeenCalled()
    execute(viewerActionScript(context, 'quote-file'))
    expect(quoteFirst).toHaveBeenCalledTimes(1)
    dispose()
    expect(execute(viewerActionScript(context, 'quote-file'))).toBe(false)
  })

  it('quotes the whole file without stale selected text and scopes custom select-all to the editor', () => {
    const root = viewer(), quote = vi.fn(), selectAll = vi.fn()
    const dispose = bindFileViewerMenu(root, () => ({ quote, selectAll }), vi.fn())
    let context = execute(viewerContextScript({ x: 0, y: 0, isEditable: false }, 'file', { text: 'old text' }))
    execute(viewerActionScript(context, 'quote-file'))
    expect(quote).toHaveBeenCalledWith(null)
    context = execute(viewerContextScript({ x: 0, y: 0, isEditable: false }, 'all', { text: '' }))
    expect(context.customSelectAll).toBe(true)
    execute(viewerActionScript(context, 'select-all'))
    expect(selectAll).toHaveBeenCalledOnce()
    dispose()
  })

  it('does not attach a file menu to unrelated document content', () => {
    viewer()
    expect(execute(viewerContextScript({ x: 0, y: 0, isEditable: false }, 'none', { text: '' }))).toBeNull()
  })

  it('translates a webview window point before hitting its own document', () => {
    const root = viewer()
    const dispose = bindFileViewerMenu(root, () => ({ quote: vi.fn() }), vi.fn())
    document.elementFromPoint = vi.fn((x, y) => x === 44 && y === 146 ? root.firstElementChild : null)
    const context = execute(viewerContextScript({ x: 800, y: 227, isEditable: false }, 'guest', { text: 'beta' }, { x: 756, y: 81 }))
    expect(context.selection.text).toBe('beta')
    expect(document.elementFromPoint).toHaveBeenCalledWith(44, 146)
    dispose()
  })

  it('disables selection-only operations for images and preserves editing actions for source editors', () => {
    const context: FileViewerMenuRequest & { viewerId: string } = { viewerId: 'image', requestId: 'image', action: 'snapshot', selection: { text: '' }, canSelectAll: false }
    const run = vi.fn()
    const image = fileViewerMenuTemplate(context, labels, run)
    expect(image.filter(item => item.type !== 'separator' && item.enabled === false).map(item => item.type !== 'separator' ? item.label : undefined)).toEqual(['Copy', 'Select all', 'Quote selection'])
    expect((image.at(-1)?.type !== 'separator' ? (image.at(-1) as { label: string }).label : undefined)).toBe('Quote file')
    const editor = fileViewerMenuTemplate({ ...context, editable: true, selection: { text: 'source' }, canSelectAll: true }, labels, run)
    expect(editor.filter(item => item.type !== 'separator').map(item => item.label)).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select all', 'Quote selection', 'Quote file'])
  })
})
