// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const preview = vi.hoisted(() => ({ openImageViewer: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/imageViewer', () => ({
  openImageViewer: preview.openImageViewer,
}))
import { MediaGrid } from '../../../../apps/desktop/src/components/media/MediaGrid'
import {
  useImageAttachDraft,
  type ImageAttachDraftState,
} from '../../../../apps/desktop/src/components/media/useImageAttachDraft'
describe('MediaGrid (#3303)', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    preview.openImageViewer.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })
  it.each([1, 2, 3, 4, 6, 9])('%i 张图使用稳定布局并把整组交给既有查看器', async (count) => {
    const images = Array.from({ length: count }, (_, index) => ({ url: `https://img/${index}.png`, alt: `图 ${index + 1}` }))
    await act(async () => root.render(createElement(MediaGrid, { images })))
    const grid = container.querySelector('[data-testid="media-grid"]')
    expect(grid?.getAttribute('data-layout')).toBe(String(count))
    const buttons = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
    expect(buttons).toHaveLength(count)
    await act(async () => buttons[count - 1]!.click())
    // 整组交给查看器,每张带上它自己的缩略图(从缩略图放大进入、关闭时缩回去)
    const thumbs = Array.from(container.querySelectorAll('img'))
    expect(preview.openImageViewer).toHaveBeenCalledWith(images.map((image, i) => ({ ...image, thumb: thumbs[i] })), count - 1)
  })
})
describe('useImageAttachDraft (#3303)', () => {
  let container: HTMLDivElement
  let root: Root
  let current: ImageAttachDraftState
  const createObjectURL = vi.fn()
  const revokeObjectURL = vi.fn()
  function Harness() {
    current = useImageAttachDraft()
    return null
  }
  beforeEach(async () => {
    createObjectURL.mockReset()
    revokeObjectURL.mockReset()
    createObjectURL.mockImplementation((file: File) => `blob:${file.name}`)
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true, writable: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(Harness)))
  })
  afterEach(() => container.remove())
  it('移除时立即回收该 URL，卸载时回收剩余 URL', async () => {
    const first = new File(['a'], 'a.png', { type: 'image/png' })
    const second = new File(['b'], 'b.jpg', { type: 'image/jpeg' })
    await act(async () => current.addFiles([first, second]))
    const firstId = current.images[0]!.id
    await act(async () => current.removeImage(firstId))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a.png')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:b.jpg')
    await act(async () => root.unmount())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:b.jpg')
  })
  it('上传函数由调用方注入，并按当前草稿顺序返回结果', async () => {
    const upload = vi.fn(async (file: File) => `remote:${file.name}`)
    await act(async () => current.addFiles([
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
    ]))
    await expect(current.uploadImages(upload)).resolves.toEqual(['remote:a.png', 'remote:b.png'])
    expect(upload).toHaveBeenCalledTimes(2)
  })
})
