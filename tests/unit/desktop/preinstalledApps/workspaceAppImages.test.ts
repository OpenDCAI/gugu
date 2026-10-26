// @vitest-environment jsdom
// Real workspace App, CodeMirror binding and file anchors, on the runtime's existing in-test file service.
// Only the upload/picker boundary is a stand-in; assertions read the text that reached the file service.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { fileOpened, loadPage, until } from '../../../../apps/desktop/src/session/app-runtime/fake-file-service'
import type { AppFileEntry } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

type TextFile = { entry: AppFileEntry; text: string; close(): void }
const START = 'left right'
const image = () => new File(['image'], 'shot.png', { type: 'image/png' })
const $ = (id: string) => document.getElementById(id)!
let cleanup = async () => {}

async function mount(readOnly = false) {
  const loaded = await loadPage<TextFile>('text')
  loaded.service.write('item-1@1', START)
  loaded.host.appFiles.open.mockImplementation(async () => {
    const opened = fileOpened('text')
    return { ...opened, access: readOnly ? 'ro' : 'rw', entry: { ...opened.entry, name: 'report.md', path: 'notes/report.md', parentId: 'notes-folder' } }
  })
  const file = await loaded.open()
  const { codemirror, bindCodemirror } = await import('../../../../apps/desktop/src/session/app-runtime/codemirror-entry')
  const upload = vi.fn(async (_where: unknown, files: File[]): Promise<AppFileEntry[]> => files.map((f) => ({ ...file.entry, id: 'image-1', name: f.name, type: 'binary', contentType: f.type })))
  const ctx = { chat: { id: 'chat-1', name: 'Images', kind: 'group', groupId: 'chat-1' }, file: { chat: 'chat-1', id: 'item-1' }, locale: 'en', capabilities: ['files:read', 'files:write'] }
  let contextChanged: (ctx: unknown) => Promise<unknown> = async () => {}
  const gugu = {
    getContext: async () => ctx,
    onContextChanged: (fn: typeof contextChanged) => { contextChanged = fn; return () => {} },
    setTabTitle: async () => {},
    onLink: () => () => {},
    codemirror: async () => codemirror,
    markdown: async () => ({ render: () => {} }),
    bind: { codemirror: bindCodemirror },
    files: { open: async () => file, list: async () => [file.entry], onChanged: () => () => {}, upload },
  }
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error The built-in App is an unbundled ES module.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
  await vi.waitFor(() => expect($('doc-status').dataset.status).toBe('online'))
  const view = codemirror.EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
  cleanup = async () => {
    await contextChanged({ ...ctx, file: undefined })
    // Let the selection bar's queued frame settle while its document still exists.
    await new Promise<void>((done) => requestAnimationFrame(() => done()))
    document.body.replaceChildren()
  }
  expect(view.state.doc.toString()).toBe(START)
  view.dispatch({ selection: { anchor: 5 } })
  return { ...loaded, file, view, upload }
}

function paste(view: Awaited<ReturnType<typeof mount>>['view'], files: File[]) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { files, types: ['Files'], getData: () => '' } })
  view.contentDOM.dispatchEvent(event)
  return event
}

afterEach(async () => { await cleanup(); cleanup = async () => {} })

describe('workspace Markdown image insertion', () => {
  test('paste uploads beside this document and inserts the stored name, with Markdown delimiters escaped', async () => {
    const { view, upload, service } = await mount()
    upload.mockResolvedValueOnce([{ ...fileOpened('text').entry, id: 'image-1', name: 'shot (2).png', type: 'binary' }])
    const picked = image()
    expect(paste(view, [picked]).defaultPrevented).toBe(true)
    await until(() => service.text('item-1@1').includes('![]('))
    expect(upload).toHaveBeenCalledExactlyOnceWith({ chat: 'chat-1', folder: 'notes-folder' }, [picked])
    expect(service.text('item-1@1')).toBe('left ![](shot%20%282%29.png)right')
  })

  test('a drop inserts at the drop position rather than the old cursor', async () => {
    const { view, service, upload } = await mount()
    vi.spyOn(view, 'posAtCoords').mockReturnValueOnce(0)
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
      dataTransfer: { value: { files: [image()] } }, clientX: { value: 1 }, clientY: { value: 1 },
    })
    view.contentDOM.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await until(() => service.text('item-1@1').includes('![]('))
    expect(service.text('item-1@1')).toBe('![](shot.png)left right')
    expect(upload).toHaveBeenCalledOnce()
  })

  test('the photo picker keeps its anchor while someone types before it and the upload is pending', async () => {
    const { view, file, service, upload } = await mount()
    let finish!: (entries: AppFileEntry[]) => void
    upload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const picker = $('image-picker') as HTMLInputElement
    const openPicker = vi.spyOn(picker, 'click').mockImplementation(() => {})
    expect(picker.accept).toBe('image/*')
    ;($('insert-image') as HTMLButtonElement).click()
    expect(openPicker).toHaveBeenCalledOnce()
    Object.defineProperty(picker, 'files', { configurable: true, value: [image()] })
    picker.dispatchEvent(new Event('change'))
    service.insertAt('item-1@1', 0, 'remote ')
    await until(() => file.text.startsWith('remote '))
    await until(() => view.state.doc.toString().startsWith('remote '))
    finish([{ ...file.entry, id: 'image-1', name: 'shot.png', type: 'binary' }])
    await until(() => service.text('item-1@1').includes('![]('))
    expect(service.text('item-1@1')).toBe('remote left ![](shot.png)right')
  })

  test('an upload refusal is visible and inserts no broken image reference', async () => {
    const { view, upload, service } = await mount()
    upload.mockRejectedValueOnce(Object.assign(new Error('Image upload refused'), { code: 'denied' }))
    paste(view, [image()])
    await vi.waitFor(() => expect($('banner').textContent).toContain('Image upload refused'))
    expect(($('banner') as HTMLElement).hidden).toBe(false)
    expect(service.text('item-1@1')).toBe(START)
  })

  test('a read-only document offers no insertion and never uploads pasted images', async () => {
    const { view, upload, service } = await mount(true)
    expect(($('insert-image') as HTMLButtonElement).hidden).toBe(true)
    paste(view, [image()])
    expect(upload).not.toHaveBeenCalled()
    expect(service.text('item-1@1')).toBe(START)
  })
})
