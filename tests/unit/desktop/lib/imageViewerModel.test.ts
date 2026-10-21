// #6607 看图查看器的纯函数:缩略图起落位置、长图判定、三档缩放、下载名。
import { describe, expect, it } from 'vitest'
import {
  downloadNameFor,
  isLongImage,
  thumbBoundsFor,
  zoomLevelsFor,
} from '../../../../apps/desktop/src/lib/imageViewer'

const VIEWPORT = { width: 1280, height: 800 }
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly

describe('thumbBoundsFor', () => {
  it('cover 缩略图(九宫格):按铺满换算整张原图的位置,并给出可见那块的裁切框', () => {
    // 100×100 的格子里铺 400×200 的图:按高铺满 ⇒ 缩到 200×100,左右各裁 50
    expect(thumbBoundsFor(rect(10, 20, 100, 100), 'cover', { width: 400, height: 200 }, VIEWPORT)).toEqual({
      x: -40,
      y: 20,
      w: 200,
      innerRect: { w: 100, h: 100, x: -50, y: 0 },
    })
  })

  it('contain 缩略图:图在盒子里留边,起落位置是图本身而不是盒子', () => {
    // 200×200 的盒子里放 400×200 的图 ⇒ 200×100,上下各留 50
    expect(thumbBoundsFor(rect(0, 0, 200, 200), 'contain', { width: 400, height: 200 }, VIEWPORT)).toEqual({ x: 0, y: 50, w: 200 })
  })

  it('其余 object-fit 按盒子本身', () => {
    expect(thumbBoundsFor(rect(5, 6, 70, 80), 'fill', { width: 400, height: 200 }, VIEWPORT)).toEqual({ x: 5, y: 6, w: 70 })
  })

  it('缩略图不在视口里(被滚走 / 收起)⇒ 没有起落位置,查看器改淡入淡出', () => {
    expect(thumbBoundsFor(rect(0, -300, 100, 100), 'cover', { width: 100, height: 100 }, VIEWPORT)).toBeUndefined()
    expect(thumbBoundsFor(rect(0, 900, 100, 100), 'cover', { width: 100, height: 100 }, VIEWPORT)).toBeUndefined()
    expect(thumbBoundsFor(rect(0, 0, 0, 0), 'cover', { width: 100, height: 100 }, VIEWPORT)).toBeUndefined()
  })
})

describe('isLongImage / zoomLevelsFor', () => {
  const phone = { width: 390, height: 844 }

  it('长截图(#6456 的 1080×11020)在手机上按宽铺开,不是缩成一条细线', () => {
    const image = { width: 1080, height: 11020 }
    expect(isLongImage(image, phone)).toBe(true)
    const fit = Math.min(1, phone.width / image.width, phone.height / image.height)
    const levels = zoomLevelsFor(image, phone, fit)
    expect(levels.initial).toBeCloseTo(390 / 1080)
    expect(levels.initial).toBeGreaterThan(fit * 4)
  })

  it('普通照片、手机截图整张可见;又细又长但本身就放得下的小图也不算长图', () => {
    expect(isLongImage({ width: 3000, height: 4000 }, phone)).toBe(false)
    expect(isLongImage({ width: 1080, height: 2400 }, phone)).toBe(false)
    expect(isLongImage({ width: 1170, height: 2532 }, VIEWPORT)).toBe(false)
    expect(isLongImage({ width: 100, height: 400 }, VIEWPORT)).toBe(false)
    expect(isLongImage({ width: 1080, height: 5000 }, VIEWPORT)).toBe(true)
    const fit = Math.min(1, 390 / 3000, 844 / 4000)
    expect(zoomLevelsFor({ width: 3000, height: 4000 }, phone, fit).initial).toBe(fit)
  })

  it('比屏幕小的图双击也要放大(PhotoSwipe 默认的 min(1, 3×fit) 在这里等于 1,双击没反应)', () => {
    const levels = zoomLevelsFor({ width: 200, height: 150 }, VIEWPORT, 1)
    expect(levels.initial).toBe(1)
    expect(levels.secondary).toBeGreaterThanOrEqual(2)
  })

  it('捏合上限至少到原图 200%,截图里的小字才看得清', () => {
    const fit = Math.min(1, 1280 / 1170, 800 / 2532)
    const levels = zoomLevelsFor({ width: 1170, height: 2532 }, VIEWPORT, fit)
    expect(levels.max).toBeGreaterThanOrEqual(2)
    expect(levels.max).toBeGreaterThanOrEqual(levels.secondary)
  })
})

describe('downloadNameFor', () => {
  it('alt 是原名就用它;没有就取 URL 末段,去掉查询串', () => {
    expect(downloadNameFor({ url: 'https://x/a/b.png?token=1', alt: 'photo.png' })).toBe('photo.png')
    expect(downloadNameFor({ url: 'https://x/a/b.png?token=1', alt: '' })).toBe('b.png')
  })

  it('data: / blob: 地址没有名字可取', () => {
    expect(downloadNameFor({ url: 'data:image/png;base64,AAAA', alt: '' })).toBe('image')
    expect(downloadNameFor({ url: 'blob:https://x/1234', alt: '' })).toBe('image')
  })
})
