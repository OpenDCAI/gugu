import { afterEach, expect, inject, it, vi } from 'vitest'
import { createSharePosterCanvas, downloadPoster } from '@/components/sharePosterCanvas'
import QRCode from 'qrcode'

function crossOriginAvatar(path = '/avatar.webp'): string {
  const url = new URL(path, inject('posterAvatarBase'))
  expect(url.origin).not.toBe(window.location.origin)
  return url.href
}

afterEach(() => vi.restoreAllMocks())

it('exports all PNG paths after drawing a real cross-origin member avatar', async () => {
  const avatar = crossOriginAvatar()
  const reference = new Image()
  reference.src = avatar
  await reference.decode()
  expect(reference.naturalWidth).toBeGreaterThan(0)
  const qrDataUrl = await QRCode.toDataURL('gugu://group/poster-cors-regression')
  const canvas = await createSharePosterCanvas({
    title: '海报跨域验证', subtitle: '群聊 · 1 位成员',
    qrDataUrl, memberAvatarUrls: [avatar], totalMemberCount: 1,
  })
  // A no-CORS image makes all of these throw SecurityError, even if its server allows CORS.
  const png = canvas.toDataURL('image/png')
  expect(png.startsWith('data:image/png;base64,')).toBe(true)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  expect(blob?.type).toBe('image/png')
  expect([...new Uint8Array(await blob!.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const referenceCanvas = document.createElement('canvas')
  referenceCanvas.width = referenceCanvas.height = 96
  const readableImage = new Image()
  readableImage.crossOrigin = 'anonymous'
  readableImage.src = avatar
  await readableImage.decode()
  referenceCanvas.getContext('2d')!.drawImage(readableImage, 0, 0, 96, 96)
  expect([...canvas.getContext('2d')!.getImageData(104, 392, 1, 1).data]).toEqual(
    [...referenceCanvas.getContext('2d')!.getImageData(48, 48, 1, 1).data],
  )

  const clicked: Array<{ href: string; filename: string }> = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, filename: this.download })
  })
  downloadPoster(canvas, 'group-poster.png')
  expect(clicked).toEqual([{ href: png, filename: 'group-poster.png' }])
})


it('rejects a remote avatar without CORS rather than exporting an omitted face', async () => {
  const avatar = crossOriginAvatar('/blocked.webp')
  const qrDataUrl = await QRCode.toDataURL('gugu://group/poster-cors-rejection')
  await expect(createSharePosterCanvas({
    title: '研究小组', subtitle: '群聊', qrDataUrl, memberAvatarUrls: [avatar],
  })).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining(avatar) }) })
})
