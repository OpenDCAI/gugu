// @vitest-environment jsdom
// #6607 看图的模块级入口:宿主登记(聊天与会话页两棵 React 树共用一个查看器)、画廊按 DOM 收集、输入框 chip 分流。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  galleryAround,
  openComposerImage,
  openImageFromThumb,
  openImageViewer,
  registerFullImage,
  registerImageViewerHost,
} from '../../../../apps/desktop/src/lib/imageViewer'

let unregister: (() => void) | null = null
afterEach(() => {
  unregister?.()
  unregister = null
  document.body.innerHTML = ''
})

function thumb(src: string, alt: string): HTMLImageElement {
  const img = document.createElement('img')
  img.alt = alt
  img.setAttribute('data-image-viewer-src', src)
  return img
}

describe('registerImageViewerHost / openImageViewer', () => {
  it('没有宿主时打开会响亮地失败,而不是静默什么都不做', () => {
    expect(() => openImageViewer([{ url: 'u', alt: '' }])).toThrow(/not mounted/)
  })

  it('只允许一个宿主;注销后可以重新登记', () => {
    unregister = registerImageViewerHost(vi.fn())
    expect(() => registerImageViewerHost(vi.fn())).toThrow(/already registered/)
    unregister()
    const host = vi.fn()
    unregister = registerImageViewerHost(host)
    openImageViewer([{ url: 'a', alt: '' }, { url: 'b', alt: '' }], 5)
    expect(host).toHaveBeenCalledWith({ items: [{ url: 'a', alt: '' }, { url: 'b', alt: '' }], index: 1 })
  })

  it('空列表是调用方的错', () => {
    unregister = registerImageViewerHost(vi.fn())
    expect(() => openImageViewer([])).toThrow(/at least one/)
  })
})

describe('galleryAround', () => {
  it('keeps each image original message context, including full-resolution upgrade, without inferring a source for other images', async () => {
    const first = thumb('https://img/first-thumb.png', 'first.png'), second = thumb('https://img/second.png', 'second.png')
    const gallery = document.createElement('div'); gallery.setAttribute('data-image-gallery', ''); gallery.append(first, second); document.body.append(gallery)
    const full = vi.fn(async () => 'blob:original')
    const stop = registerFullImage(first, full, undefined, undefined, { chatId: 'source-chat', messageId: 'source-message' })
    expect(galleryAround(second).items[0].source).toEqual({ chatId: 'source-chat', messageId: 'source-message' })
    expect(galleryAround(second).items[1].source).toBeUndefined()
    await expect(galleryAround(first).items[0].full?.()).resolves.toBe('blob:original')
    stop()
    expect(galleryAround(first).items[0].source).toBeUndefined()
  })
  it('收集同一画廊里此刻渲染着的全部图,按文档顺序,从被点那张开始', () => {
    const list = document.createElement('div')
    list.setAttribute('data-image-gallery', '')
    const a = thumb('https://img/a.png', 'a.png')
    const b = thumb('https://img/b.gif', 'b.gif')
    const c = thumb('https://img/c.jpg', 'c.jpg')
    const stranger = document.createElement('img') // 头像之类:没标记,不进画廊
    list.append(a, stranger, b, c)
    const otherList = document.createElement('div')
    otherList.setAttribute('data-image-gallery', '')
    otherList.append(thumb('https://img/other.png', 'other.png'))
    document.body.append(list, otherList)

    const { items, index } = galleryAround(b)
    expect(index).toBe(1)
    expect(items.map((item) => item.url)).toEqual(['https://img/a.png', 'https://img/b.gif', 'https://img/c.jpg'])
    expect(items[0]).toMatchObject({ alt: 'a.png', thumb: a })
    expect(items[1].thumb).toBe(b)
  })

  it('不在任何画廊里 ⇒ 只看这一张', () => {
    const lone = thumb('https://img/lone.png', 'lone.png')
    document.body.append(lone)
    expect(galleryAround(lone)).toEqual({ items: [{ url: 'https://img/lone.png', alt: 'lone.png', thumb: lone }], index: 0 })
  })

  it('被点的缩略图没标原图地址是接线错误,响亮地失败', () => {
    const list = document.createElement('div')
    list.setAttribute('data-image-gallery', '')
    const bare = document.createElement('img')
    list.append(thumb('https://img/a.png', 'a'), bare)
    document.body.append(list)
    expect(() => galleryAround(bare)).toThrow(/not marked/)
  })

  it('openImageFromThumb 把画廊交给宿主', () => {
    const host = vi.fn()
    unregister = registerImageViewerHost(host)
    const list = document.createElement('div')
    list.setAttribute('data-image-gallery', '')
    const a = thumb('https://img/a.png', 'a')
    const b = thumb('https://img/b.png', 'b')
    list.append(a, b)
    document.body.append(list)
    openImageFromThumb(b)
    expect(host).toHaveBeenCalledWith(expect.objectContaining({ index: 1 }))
    expect(host.mock.calls[0][0].items).toHaveLength(2)
  })

  it('carries original file facts through the gallery independently of thumbnail alt', () => {
    const image = thumb('blob:thumbnail', 'a description')
    const file = { name: '截图.v2', contentType: 'image/png' }
    const load = vi.fn(async () => 'blob:original')
    const release = registerFullImage(image, load, undefined, file)
    expect(galleryAround(image).items[0]).toMatchObject({ alt: 'a description', file, full: load })
    release()
    expect(galleryAround(image).items[0].file).toBeUndefined()
  })
})

describe('openComposerImage', () => {
  it('图片 chip 进查看器;文本附件与读不到字节的图交回宿主的附件对话框', () => {
    const host = vi.fn()
    unregister = registerImageViewerHost(host)
    expect(openComposerImage({ kind: 'image', name: '截图.v2', mimeType: 'image/png', previewUrl: 'data:image/png;base64,AA' })).toBe(true)
    expect(host).toHaveBeenCalledWith({ items: [{ url: 'data:image/png;base64,AA', alt: '截图.v2', file: { name: '截图.v2', contentType: 'image/png' } }], index: 0 })
    expect(openComposerImage({ kind: 'file', name: 'notes.md' })).toBe(false)
    expect(openComposerImage({ kind: 'image', name: 'broken.png' })).toBe(false)
    expect(host).toHaveBeenCalledTimes(1)
  })
})
