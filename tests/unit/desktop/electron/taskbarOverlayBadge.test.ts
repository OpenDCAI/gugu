import { describe, expect, test } from 'vitest'
import {
  BADGE_BACKGROUND,
  BADGE_FOREGROUND,
  OVERLAY_BADGE_SIZE,
  buildOverlayBadgeBitmap,
  overlayBadgeGeometryFor,
} from '../../../../apps/desktop/electron/tray-badge'

/**
 * #5929 Windows 任务栏 overlay 只许画角标。
 *
 * 之前喂给 `setOverlayIcon` 的是**托盘图本身**(一只咕咕鸟),而 overlay 是原样叠在任务栏按钮的
 * 应用图标上的 —— 于是任务栏上两只鸟拼在一起(owner 实机照片 + win-dev Server 2025 复现)。
 * 这里守住的性质:画布四角必须透明(应用图标透出来),中心必须是红底白字的角标。
 */

const SIZE = OVERLAY_BADGE_SIZE

function pixel(bitmap: Buffer, size: number, x: number, y: number) {
  const at = (y * size + x) * 4
  // BGRA —— 见 tray-badge.ts 文件头,这是实测的字节序。
  return { b: bitmap[at], g: bitmap[at + 1], r: bitmap[at + 2], a: bitmap[at + 3] }
}

describe('buildOverlayBadgeBitmap', () => {
  test('空标签给一张整块透明的图 —— 没有未读时 overlay 不该留下任何痕迹', () => {
    const bitmap = buildOverlayBadgeBitmap('', SIZE)
    expect(bitmap.length).toBe(SIZE * SIZE * 4)
    expect(bitmap.every((byte) => byte === 0)).toBe(true)
  })

  test('四角透明 —— 这是「应用图标不被整块遮住」的判据', () => {
    const bitmap = buildOverlayBadgeBitmap('3', SIZE)
    for (const [x, y] of [
      [0, 0],
      [SIZE - 1, 0],
      [0, SIZE - 1],
      [SIZE - 1, SIZE - 1],
    ]) {
      expect(pixel(bitmap, SIZE, x, y).a).toBe(0)
    }
  })

  test('圆心是红底,并且画出了白色数字', () => {
    const bitmap = buildOverlayBadgeBitmap('3', SIZE)
    const mid = pixel(bitmap, SIZE, SIZE / 2, 1 + SIZE / 2)
    expect(mid.a).toBe(0xff)
    expect([BADGE_BACKGROUND.r, BADGE_FOREGROUND.r]).toContain(mid.r)

    let white = 0
    let red = 0
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      const px = pixel(bitmap, SIZE, i % SIZE, Math.floor(i / SIZE))
      if (px.a !== 0xff) continue
      if (px.r === BADGE_FOREGROUND.r && px.g === BADGE_FOREGROUND.g) white += 1
      if (px.r === BADGE_BACKGROUND.r && px.g === BADGE_BACKGROUND.g) red += 1
    }
    expect(white).toBeGreaterThan(0)
    expect(red).toBeGreaterThan(white)
  })

  test('99+ 三个字形也塞得进方画布,不会被画布边裁掉', () => {
    const geometry = overlayBadgeGeometryFor(SIZE, '99+')
    expect(geometry.scale).toBeGreaterThanOrEqual(1)

    const bitmap = buildOverlayBadgeBitmap('99+', SIZE)
    const xs: number[] = []
    const ys: number[] = []
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const px = pixel(bitmap, SIZE, x, y)
        if (px.a === 0xff && px.r === BADGE_FOREGROUND.r && px.g === BADGE_FOREGROUND.g) {
          xs.push(x)
          ys.push(y)
        }
      }
    }
    expect(xs.length).toBeGreaterThan(0)

    // 点阵字形 3 宽 5 高;三个字形加两个字距,整块墨的外接框必须**刚好**这么大 ——
    // 小一圈就说明被画布边裁掉了,而裁掉的那一列在任务栏上看不出来是少了还是本来就没有。
    const glyphs = 3
    expect(Math.max(...xs) - Math.min(...xs) + 1).toBe(
      (glyphs * 3 + (glyphs - 1) * geometry.tracking) * geometry.scale,
    )
    expect(Math.max(...ys) - Math.min(...ys) + 1).toBe(5 * geometry.scale)
    expect(Math.min(...xs)).toBeGreaterThan(0)
    expect(Math.max(...xs)).toBeLessThan(SIZE - 1)
  })
})
