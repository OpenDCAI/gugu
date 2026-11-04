import { describe, expect, it, vi } from 'vitest'
import { createScreenCapture } from '../../../../apps/desktop/electron/device-actions/screen-capture'

class Image {
  constructor(private width: number, private height: number, private empty = false) {}
  isEmpty() { return this.empty }
  getSize() { return { width: this.width, height: this.height } }
  resize = vi.fn((size: { width: number; height: number; quality: 'good' }) => new Image(size.width, size.height))
  toJPEG = vi.fn(() => Buffer.from('captured-jpeg'))
}

function setup(platform: NodeJS.Platform = 'darwin') {
  let access = 'granted'
  const image = new Image(1920, 1080)
  const sources = vi.fn(async () => [{ display_id: '9', thumbnail: image }])
  const screenAccess = vi.fn(() => access)
  const capture = createScreenCapture({ platform, screenAccess, sources,
    primaryDisplay: () => ({ id: 9, size: { width: 1920, height: 1080 } }), displayCount: () => 2 })
  return { capture, sources, screenAccess, image, setAccess: (next: string) => { access = next } }
}

describe('Electron screen capture', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('%s uses the same screen source and image path', async platform => {
    const { capture, sources } = setup(platform)
    expect(await capture({ maxEdge: 960 })).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('captured-jpeg').toString('base64'), width: 960, height: 540, displays: 2 })
    expect(sources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 960, height: 540 } })
  })

  it('uses actual thumbnail dimensions, which Electron does not guarantee match the request', async () => {
    const { capture, sources } = setup()
    sources.mockResolvedValue([{ display_id: '9', thumbnail: new Image(800, 600) }])
    expect(await capture({ maxEdge: 960 })).toMatchObject({ width: 800, height: 600 })
  })

  it('selects the primary display by id rather than source order', async () => {
    const { capture, sources } = setup()
    const other = new Image(640, 480)
    const primary = new Image(800, 500)
    sources.mockResolvedValue([{ display_id: '4', thumbnail: other }, { display_id: '9', thumbnail: primary }])
    expect(await capture({ maxEdge: 960 })).toMatchObject({ width: 800, height: 500 })
    expect(other.toJPEG).not.toHaveBeenCalled()
  })

  it('accepts one system-selected source without a display id, as with PipeWire', async () => {
    const { capture, sources } = setup('linux')
    sources.mockResolvedValue([{ display_id: '', thumbnail: new Image(720, 480) }])
    expect(await capture({ maxEdge: 960 })).toMatchObject({ width: 720, height: 480 })
  })

  it.each([
    { sources: [{ display_id: '4', thumbnail: new Image(640, 480) }] },
    { sources: [{ display_id: '', thumbnail: new Image(640, 480) }, { display_id: '', thumbnail: new Image(800, 500) }] },
    { sources: [] },
    { sources: [{ display_id: '9', thumbnail: new Image(0, 0, true) }] },
  ])('does not substitute an unidentified or empty screen capture', async ({ sources }) => {
    const { capture, sources: getSources } = setup()
    getSources.mockResolvedValue(sources)
    await expect(capture({ maxEdge: 960 })).rejects.toMatchObject({ code: 'execution_failed' })
  })

  it.each(['denied', 'not-determined', 'restricted'])('refuses macOS capture before requesting sources when access is %s', async access => {
    const { capture, sources, setAccess } = setup()
    setAccess(access)
    await expect(capture({ maxEdge: 960 })).rejects.toMatchObject({ code: 'os_permission' })
    expect(sources).not.toHaveBeenCalled()
  })

  it('does not publish a capture if macOS access was revoked during capture', async () => {
    const { capture, sources, image, setAccess } = setup()
    sources.mockImplementation(async () => { setAccess('denied'); return [{ display_id: '9', thumbnail: image }] })
    await expect(capture({ maxEdge: 960 })).rejects.toMatchObject({ code: 'os_permission' })
    expect(image.toJPEG).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)('%s does not consult a macOS permission signal', async platform => {
    const { capture, screenAccess, setAccess } = setup(platform)
    setAccess('denied')
    await capture({ maxEdge: 960 })
    expect(screenAccess).not.toHaveBeenCalled()
  })
})
