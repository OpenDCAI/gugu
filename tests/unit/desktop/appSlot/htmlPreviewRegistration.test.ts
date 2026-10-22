import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { previewDocumentHtml } from '@/session/shared/preview/preview-link-script'

const files = vi.hoisted(() => ({ createDocumentPreview: vi.fn(), setPreviewDocument: vi.fn(), releasePreview: vi.fn() }))
vi.mock('@/session/renderer/lib/ipc', () => ({ rpc: { workspace: { files } } }))
import { registerDocumentPreview } from '@/components/preview/html-preview-registration'

beforeEach(() => vi.clearAllMocks())
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('document preview transports', () => {
  it('web/mobile owns one Blob URL, replaces it on edits and revokes it on close', async () => {
    vi.stubGlobal('window', {})
    const blobs: Blob[] = []
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return `blob:preview-${blobs.length}`
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const preview = await registerDocumentPreview('<h1>initial</h1>')
    if (!preview.ok) throw Error(preview.message)
    expect(preview.url).toBe('blob:preview-1')
    expect(await blobs[0]!.text()).toBe(previewDocumentHtml('<h1>initial</h1>', true))
    expect(await preview.update('<h1>edited</h1>')).toBe('blob:preview-2')
    expect(await blobs[1]!.text()).toBe(previewDocumentHtml('<h1>edited</h1>', true))
    expect(revoke).toHaveBeenCalledWith('blob:preview-1')
    preview.release()
    expect(revoke).toHaveBeenLastCalledWith('blob:preview-2')
    expect(create).toHaveBeenCalledTimes(2)
    expect(files.createDocumentPreview).not.toHaveBeenCalled()
  })

  it('desktop keeps its protocol registration while updating and releasing through the local host', async () => {
    vi.stubGlobal('window', { electronAPI: {} })
    files.createDocumentPreview.mockResolvedValue({ success: true, data: { url: 'gugu-preview://document/index.html', previewId: 'document' } })
    files.setPreviewDocument.mockResolvedValue({ success: true, data: { success: true } })
    const preview = await registerDocumentPreview('<h1>initial</h1>')
    if (!preview.ok) throw Error(preview.message)
    expect(preview.url).toBe('gugu-preview://document/index.html?r=0')
    expect(await preview.update('edited')).toBe('gugu-preview://document/index.html?r=1')
    expect(files.setPreviewDocument).toHaveBeenCalledWith('document', 'edited')
    preview.release()
    expect(files.releasePreview).toHaveBeenCalledWith('document')
    expect(files.createDocumentPreview).toHaveBeenCalledWith('<h1>initial</h1>')
  })

  it('a host authorization failure is shown without silently switching to Blob transport', async () => {
    vi.stubGlobal('window', { electronAPI: {} })
    files.createDocumentPreview.mockResolvedValue({ success: false, error: { type: 'not_allowed', message: 'Not allowed' } })
    const blob = vi.spyOn(URL, 'createObjectURL')
    expect(await registerDocumentPreview('body')).toEqual({ ok: false, message: 'Not allowed' })
    expect(blob).not.toHaveBeenCalled()
  })
})
