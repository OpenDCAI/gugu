/**
 * @@@5295 托盘图标上的数字角标（参考微信）。
 *
 * 为什么要自己画像素：仓库没有任何图像库（sharp/canvas 一个都没有），托盘资产是 6 个静态
 * PNG/ICO。Electron 的 `nativeImage` 能给出原始位图、也能从原始位图建回图像，所以合成完全可以
 * 在进程内做，❌ 不必为了画两个数字引一个几 MB 的原生依赖。
 *
 * ⚠️ **字节序是 BGRA**，不是 RGBA —— 这是实测的，不是照文档抄的：
 * 往 `createFromBitmap` 写 `(0,0,255,255)` 再 `toPNG()` 解出来是纯红，写 `(255,0,0,255)` 解出来是
 * 纯蓝（对照像素给出了相反读数，所以这个读数能判假）。搞反的症状是角标变成蓝色，
 * 不报错、不崩溃，只是颜色不对。
 *
 * macOS 不走这条路：菜单栏图标是 template 图（单色，由系统按明暗反相），往里画一个红色块会被
 * 压成黑色方块。macOS 用原生的 `tray.setTitle()` 在图标旁边写文本，见 main.ts 的调用点。
 */

/** 3×5 点阵字形。只有角标要用的这几个字符 —— ❌ 不要在这里长成一套字体。 */
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000],
}

const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5

/** 微信式收敛：0 不画，超过 99 画 `99+`。 */
export function formatBadgeCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  const rounded = Math.floor(count)
  return rounded > 99 ? '99+' : String(rounded)
}

export type BadgeColor = { r: number; g: number; b: number }

/** 微信红。写成常量而不是散在调用点,换色只改一处。 */
export const BADGE_BACKGROUND: BadgeColor = { r: 0xfa, g: 0x37, b: 0x34 }
export const BADGE_FOREGROUND: BadgeColor = { r: 0xff, g: 0xff, b: 0xff }

export type BadgeGeometry = {
  /** 点阵放大倍数。32px 图标用 2,16px 用 1。 */
  scale: number
  /** 字形之间的空隙(已按 scale 放大前的点数)。 */
  tracking: number
  /** 数字与角标边缘的留白(像素)。 */
  padding: number
}

export function badgeGeometryFor(iconSize: number): BadgeGeometry {
  return iconSize >= 32
    ? { scale: 2, tracking: 1, padding: 2 }
    : { scale: 1, tracking: 1, padding: 1 }
}

export function measureBadge(label: string, geometry: BadgeGeometry): { width: number; height: number } {
  const { scale, tracking, padding } = geometry
  const glyphs = label.length
  const inkWidth = glyphs * GLYPH_WIDTH * scale + Math.max(0, glyphs - 1) * tracking * scale
  return {
    width: inkWidth + padding * 2,
    height: GLYPH_HEIGHT * scale + padding * 2,
  }
}

function blend(bitmap: Buffer, offset: number, color: BadgeColor): void {
  // BGRA —— 见文件头。
  bitmap[offset] = color.b
  bitmap[offset + 1] = color.g
  bitmap[offset + 2] = color.r
  bitmap[offset + 3] = 0xff
}

/**
 * 把角标画进一份 BGRA 位图（原地修改传入的 buffer 副本并返回它）。
 *
 * 纯函数、不碰 Electron —— 于是可以在单测里喂一张合成位图直接验像素,
 * ❌ 不必起一个真 Electron 才知道画对没有。
 */
export function paintBadgeOnBitmap(
  bitmap: Buffer,
  width: number,
  height: number,
  label: string,
  geometry: BadgeGeometry = badgeGeometryFor(Math.min(width, height)),
): Buffer {
  if (label.length === 0) return bitmap
  const { padding } = geometry
  const size = measureBadge(label, geometry)
  const originX = Math.max(0, width - size.width)
  const originY = 0
  const radius = Math.min(size.height / 2, size.width / 2)

  // 底：圆角矩形（单数字时半径 = 高的一半,退化成圆）。
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const px = originX + x
      const py = originY + y
      if (px >= width || py >= height) continue
      if (!insideRoundedRect(x, y, size.width, size.height, radius)) continue
      blend(bitmap, (py * width + px) * 4, BADGE_BACKGROUND)
    }
  }

  drawLabel(bitmap, width, height, label, geometry, originX + padding, originY + padding)
  return bitmap
}

/** 把点阵数字画进位图。托盘角标与任务栏 overlay 共用同一套字形,❌ 别各画各的。 */
function drawLabel(
  bitmap: Buffer,
  width: number,
  height: number,
  label: string,
  geometry: BadgeGeometry,
  startX: number,
  startY: number,
): void {
  const { scale, tracking } = geometry
  let penX = startX
  for (const char of label) {
    const glyph = GLYPHS[char]
    if (!glyph) continue
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const bits = glyph[row] ?? 0
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if ((bits & (1 << (GLYPH_WIDTH - 1 - col))) === 0) continue
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const px = penX + col * scale + dx
            const py = startY + row * scale + dy
            if (px < 0 || py < 0 || px >= width || py >= height) continue
            blend(bitmap, (py * width + px) * 4, BADGE_FOREGROUND)
          }
        }
      }
    }
    penX += (GLYPH_WIDTH + tracking) * scale
  }
}

function insideRoundedRect(x: number, y: number, w: number, h: number, radius: number): boolean {
  const r = Math.min(radius, w / 2, h / 2)
  const cx = x < r ? r : x > w - 1 - r ? w - 1 - r : x
  const cy = y < r ? r : y > h - 1 - r ? h - 1 - r : y
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r + r
}

/**
 * @@@5929-overlay Windows 任务栏 overlay 用的「只有角标」的图。
 *
 * ❌ **不能把托盘图当 overlay 交给 Windows**。`setOverlayIcon` 是把整张图原样叠在任务栏按钮的
 * 应用图标上 —— 喂一张咕咕鸟进去，任务栏上就是两只鸟拼在一起（owner 2026-09-19 实机照片）。
 * 2026-09-20 在 win-dev（Windows Server 2025 build 26100）上用最小 Electron 靶子复现并定位：
 * 这一代任务栏把 overlay 画在按钮的**右上角**，尺寸约为应用图标的一半，且溢出图标边界 ——
 * 老文档里「lower-right corner」的说法在这台上不成立，位置不是我们能选的，**能选的只有画什么**。
 * 微信 / Slack 的做法是 overlay 只放角标本身，底图留给应用图标，本函数就是这个。
 *
 * 画布是**方的且整块透明**：HICON 要方图，透明处 Windows 不叠，于是应用图标只被角标那一小片遮住。
 *
 * 32 是按 `SM_CXSMICON` 取的：100% 缩放下 Windows 要 16px、200% 要 32px —— 取大的那档，
 * 常见的笔记本(200%)是 1:1，100% 是缩小(不糊)。❌ 别改小到 16：那样 200% 屏上是放大。
 */
export const OVERLAY_BADGE_SIZE = 32

/** 让点阵在方画布里尽量大又不出界：宽高两头各算一个上限，取小的。 */
export function overlayBadgeGeometryFor(size: number, label: string): BadgeGeometry {
  const padding = Math.max(1, Math.round(size * 0.14))
  const inner = Math.max(1, size - padding * 2)
  const glyphs = Math.max(1, label.length)
  const tracking = 1
  const unitsWide = glyphs * GLYPH_WIDTH + (glyphs - 1) * tracking
  const scale = Math.max(1, Math.min(Math.floor(inner / unitsWide), Math.floor(inner / GLYPH_HEIGHT)))
  return { scale, tracking, padding }
}

/**
 * 出一张 `size × size` 的 BGRA 位图：透明底 + 居中的红色圆形角标 + 白色数字。
 * 纯函数，不碰 Electron —— 单测直接读像素，❌ 不必起一个真 Electron 才知道画对没有。
 */
export function buildOverlayBadgeBitmap(label: string, size: number = OVERLAY_BADGE_SIZE): Buffer {
  // 全零 = 全透明。Windows 只叠非透明像素，所以应用图标在角标之外原样露出。
  const bitmap = Buffer.alloc(size * size * 4, 0)
  if (label.length === 0) return bitmap

  const geometry = overlayBadgeGeometryFor(size, label)
  const radius = size / 2
  const center = (size - 1) / 2
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center
      const dy = y - center
      if (dx * dx + dy * dy > radius * radius) continue
      blend(bitmap, (y * size + x) * 4, BADGE_BACKGROUND)
    }
  }

  const ink = measureBadge(label, geometry)
  const inkWidth = ink.width - geometry.padding * 2
  const inkHeight = ink.height - geometry.padding * 2
  drawLabel(
    bitmap,
    size,
    size,
    label,
    geometry,
    Math.round((size - inkWidth) / 2),
    Math.round((size - inkHeight) / 2),
  )
  return bitmap
}
