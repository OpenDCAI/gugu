// @vitest-environment jsdom
import { act, createElement } from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageFilePreview, type PreviewFile } from '../../../../apps/desktop/src/components/chat/MessageFilePreview'
import { MissingFileObjectError } from '@gugu/core/shared/fileResolver'
import { i18n } from '../../../../apps/desktop/src/i18n'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ bytes: vi.fn(), preview: vi.fn(), image: vi.fn(), external: vi.fn(), download: vi.fn() }))
vi.mock('@/lib/attachmentBytes', () => ({ attachmentBytes: io.bytes, attachmentPreview: io.preview, openAttachmentImage: io.image, openAttachmentInSystemApp: io.external, sourceKeyOf: () => 'message:missing-preview' }))
vi.mock('@/lib/download', () => ({ downloadBlob: io.download }))

const file: PreviewFile = { kind: 'file', fileName: 'notes.txt', mimeType: 'text/plain', sizeBytes: 5, source: { kind: 'message', messageId: 'missing-preview' } }
const translate = i18n.getFixedT('zh-CN', 'messaging')
describe('file preview missing-object actions', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    vi.stubGlobal('Blob', NodeBlob)
    Object.values(io).forEach(mock => mock.mockReset())
    io.external.mockResolvedValue(undefined)
    io.bytes.mockResolvedValue({ status: 'ready', blob: new Blob(['notes']) })
    harness = createReactHarness()
  })
  afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
  const button = (label: string) => [...harness.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label)
  const download = () => button(translate('chatArea.filePreview.download'))
  const external = () => button(translate('chatArea.filePreview.openExternal'))
  async function render(value = file, mobile = false) {
    await renderWithAppProviders(harness, createElement(MessageFilePreview, { file: value, mobile, onClose: vi.fn() }))
  }
  async function settled(text: string) {
    await vi.waitFor(async () => { await act(async () => {}); expect(harness.container.textContent).toContain(text) })
  }
  function assertNoReadActions() {
    expect(download()?.disabled ?? true).toBe(true)
    expect(external()?.disabled ?? true).toBe(true)
  }
  it.each([[false, 'file'], [true, 'file'], [false, 'image'], [true, 'image']] as const)('blocks reading a missing %s/%s preview without another request', async (mobile, kind) => {
    io.bytes.mockResolvedValue({ status: 'missing' })
    io.image.mockRejectedValue(new MissingFileObjectError())
    await render(kind === 'image' ? { ...file, kind: 'image', fileName: 'photo.png', mimeType: 'image/png' } : file, mobile)
    await settled(translate('attachmentView.fileMissing'))
    await act(async () => { download()?.click(); external()?.click() })
    expect(kind === 'image' ? io.image : io.bytes).toHaveBeenCalledTimes(1)
    expect(io.external).not.toHaveBeenCalled()
    assertNoReadActions()
  })
  it.each(['network', 'HTTP 403', 'HTTP 500', 'HTTP 503'])('retains an actual download retry after %s', async reason => {
    io.bytes.mockRejectedValueOnce(new Error(reason))
    await render(); await settled(translate('attachmentView.fileUnavailable'))
    expect(download()?.disabled).toBe(false)
    expect(external()?.disabled).toBe(false)
    await act(async () => { download()!.click() })
    expect(io.bytes).toHaveBeenCalledTimes(2)
    expect(io.download).toHaveBeenCalledTimes(1)
    expect(harness.container.textContent).not.toContain(translate('attachmentView.fileMissing'))
  })
  it.each(['download', 'external'] as const)('remembers a late missing result from the %s action', async action => {
    await render()
    await vi.waitFor(async () => { await act(async () => {}); expect(harness.container.querySelector('pre')?.textContent).toBe('notes') })
    if (action === 'download') io.bytes.mockResolvedValueOnce({ status: 'missing' })
    else io.external.mockRejectedValueOnce(new MissingFileObjectError())
    await act(async () => { (action === 'download' ? download() : external())!.click() })
    await settled(translate('attachmentView.fileMissing'))
    assertNoReadActions()
    const reads = io.bytes.mock.calls.length, opens = io.external.mock.calls.length
    await act(async () => { download()?.click(); external()?.click() })
    expect(io.bytes).toHaveBeenCalledTimes(reads); expect(io.external).toHaveBeenCalledTimes(opens)
  })
  it.each(['missing', 'network'] as const)('preserves %s during video URL renewal', async failure => {
    const content = vi.fn().mockResolvedValueOnce({ url: 'https://files.invalid/video', expiresAt: Date.now() - 1 })
      .mockRejectedValueOnce(failure === 'missing' ? new MissingFileObjectError() : new Error('network'))
    io.preview.mockResolvedValue({ status: 'ready', content, dispose: vi.fn(async () => {}) })
    await render({ ...file, fileName: 'clip.webm', mimeType: 'video/webm' })
    const video = harness.container.querySelector('video')!
    expect(video).not.toBeNull()
    await act(async () => { video.dispatchEvent(new Event('error')) })
    await settled(translate(failure === 'missing' ? 'attachmentView.fileMissing' : 'attachmentView.fileUnavailable'))
    expect(content).toHaveBeenCalledTimes(2)
    if (failure === 'missing') assertNoReadActions()
    else {
      expect(download()?.disabled).toBe(false)
      await act(async () => { download()!.click() })
      expect(io.bytes).toHaveBeenCalledTimes(1); expect(io.download).toHaveBeenCalledTimes(1)
    }
  })
})
