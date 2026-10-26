// @@@share-poster (#903) - Pure canvas composition logic (no React) for share poster generation.
// Kept in a separate .ts file to avoid react-refresh "only export components" warnings.

import { writeImageBlobToClipboard } from '../lib/imageClipboard'
import { i18n } from '../i18n'
import { normalizeAvatarUrl, reportInvalidAvatarUrl } from '@gugu/core/shared/ui/avatarUrl'

/**
 * @@@cjk-per-platform — 海报是 canvas 画的,拿不到 CSS 变量,所以字体栈在这里**再写一遍**。
 * 它必须与 `styles/tokens.css` 的 `--font-family-system` 同形:两端各点各的原生中文字体,
 * 否则 Windows 上生成的海报中文落到系统随便给的兜底,与产品界面不是一张脸。
 * ❌ 别在下面各处再手写这串 —— 这里是这条 canvas 路径的唯一一处。
 */
const POSTER_FONT_STACK = "Sora, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

export interface PosterOptions {
  title: string
  subtitle: string
  qrDataUrl: string
  /** Poster canvas width in px (default 360) */
  width?: number
  /** Poster canvas height in px (default 480) */
  height?: number
  // @@@445 群分享海报:成员头像只接受已解析的 canonical URL/dataURL 或显式 null 空槽。
  // 有成员槽位时走群布局（即使全员缺头像）；没有成员槽位才保持原「居中 QR」名片布局。
  memberAvatarUrls?: Array<string | null>
  /** 群总成员数(用于「+N」溢出计数;memberAvatarUrls 已截到 ≤9,不能拿它算 N)。 */
  totalMemberCount?: number
  /** QR 下方小字(默认「扫码加入 咕咕」)。群分享传「扫码加入群聊」。 */
  qrCaption?: string
  /** 底部 CTA 文案(默认「用 咕咕 连接你的 AI 协作网络」)。 */
  ctaText?: string
}

const ACCENT = '#ff6040'
const BG_TOP = '#111114'
const BG_CARD = '#1a1a1e'
const TEXT_PRIMARY = 'rgba(255,255,255,0.9)'
const TEXT_SECONDARY = 'rgba(255,255,255,0.45)'
const BORDER = 'rgba(255,255,255,0.08)'

function normalizePosterMemberAvatarUrls(urls: Array<string | null>): Array<string | null> {
  return urls.map((url, index) => {
    reportInvalidAvatarUrl(url, `poster member slot ${index}`)
    return normalizeAvatarUrl(url)
  })
}

/**
 * Draws a share poster onto an off-screen canvas and returns it.
 * The caller can then call canvas.toBlob() / canvas.toDataURL() as needed.
 */
export function drawSharePoster(opts: PosterOptions, images: Map<string, HTMLImageElement>): HTMLCanvasElement {
  const W = opts.width ?? 360
  const H = opts.height ?? 480
  const QR_SIZE = 140
  const PADDING = 28

  const canvas = document.createElement('canvas')
  // Render at 2× for retina sharpness
  canvas.width = W * 2
  canvas.height = H * 2
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`

  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = BG_CARD
  ctx.fillRect(0, 0, W, H)

  // Top gradient strip (brand accent → dark)
  const grad = ctx.createLinearGradient(0, 0, W, 0)
  grad.addColorStop(0, 'rgba(255,96,64,0.18)')
  grad.addColorStop(1, 'rgba(17,17,20,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, 120)

  // ── Brand mark ──────────────────────────────────────────────────────────────
  ctx.font = `600 22px ${POSTER_FONT_STACK}`
  ctx.fillStyle = TEXT_PRIMARY
  ctx.textBaseline = 'top'
  ctx.fillText('咕咕', PADDING, PADDING)

  // Accent dot after brand name
  ctx.beginPath()
  ctx.arc(PADDING + 44 + 5, PADDING + 10, 3, 0, Math.PI * 2)
  ctx.fillStyle = ACCENT
  ctx.fill()

  // ── Title ───────────────────────────────────────────────────────────────────
  ctx.font = `600 18px ${POSTER_FONT_STACK}`
  ctx.fillStyle = TEXT_PRIMARY
  ctx.textBaseline = 'top'
  const titleMaxWidth = W - PADDING * 2
  drawWrappedText(ctx, opts.title, PADDING, 72, titleMaxWidth, 26, 2)

  // ── Subtitle ────────────────────────────────────────────────────────────────
  ctx.font = `400 13px ${POSTER_FONT_STACK}`
  ctx.fillStyle = TEXT_SECONDARY
  ctx.textBaseline = 'top'
  drawWrappedText(ctx, opts.subtitle, PADDING, 106, titleMaxWidth, 18, 2)

  // ── Divider ─────────────────────────────────────────────────────────────────
  ctx.strokeStyle = BORDER
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.moveTo(PADDING, 148)
  ctx.lineTo(W - PADDING, 148)
  ctx.stroke()

  const memberUrls = normalizePosterMemberAvatarUrls(opts.memberAvatarUrls ?? [])
  const isGroup = memberUrls.length > 0
  const qrCaption = opts.qrCaption ?? i18n.t('sharing.scanToJoinGugu', { ns: 'contacts' })
  const ctaText = opts.ctaText ?? i18n.t('sharing.connectCta', { ns: 'contacts' })

  if (isGroup) {
    // ── 群分享布局:成员头像组合(微信式叠放圆) + 右下角 QR + 邀请 CTA(owner #445) ──
    const AV = 48
    const OVERLAP = 14
    const shown = memberUrls.slice(0, 5)
    const my = 172
    let mx = PADDING
    for (const url of shown) {
      // 底色描边:叠放时前圆用海报底色「切」出与后圆的间隙(微信式叠放,底色=海报背景 BG_CARD)。
      ctx.beginPath()
      ctx.arc(mx + AV / 2, my + AV / 2, AV / 2 + 2, 0, Math.PI * 2)
      ctx.fillStyle = BG_CARD
      ctx.fill()
      ctx.save()
      ctx.beginPath()
      ctx.arc(mx + AV / 2, my + AV / 2, AV / 2, 0, Math.PI * 2)
      ctx.clip()
      // @@@445 用预载好的 Image 元素(images map),别在此 new Image() —— 新元素 complete 在非 Chromium /
      // 缓存竞态下可能为 false,会让成员头像全落暗块占位。
      const img = url ? images.get(url) : undefined
      if (img && img.naturalWidth > 0) {
        ctx.drawImage(img, mx, my, AV, AV)
      } else {
        if (url) console.error('[Avatar] failed to load canonical poster avatar: ' + url)
        drawEmptyMemberAvatar(ctx, mx, my, AV)
      }
      ctx.restore()
      mx += AV - OVERLAP
    }
    // 「+N」溢出:N = 总成员数 − 已画(非 memberUrls.length,后者已截到 ≤9)。
    const overflow = (opts.totalMemberCount ?? memberUrls.length) - shown.length
    if (overflow > 0) {
      ctx.beginPath()
      ctx.arc(mx + AV / 2, my + AV / 2, AV / 2, 0, Math.PI * 2)
      ctx.fillStyle = '#2a2a30'
      ctx.fill()
      ctx.font = `600 14px ${POSTER_FONT_STACK}`
      ctx.fillStyle = TEXT_PRIMARY
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(`+${overflow}`, mx + AV / 2, my + AV / 2)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
    }

    // QR 右下角
    const GQR = 104
    const gqrX = W - PADDING - GQR
    const gqrY = H - PADDING - GQR - 16
    ctx.fillStyle = '#ffffff'
    roundRect(ctx, gqrX - 7, gqrY - 7, GQR + 14, GQR + 14, 9)
    ctx.fill()
    const gqrImg = images.get(opts.qrDataUrl)
    if (gqrImg && gqrImg.naturalWidth > 0) ctx.drawImage(gqrImg, gqrX, gqrY, GQR, GQR)
    ctx.font = `400 10px ${POSTER_FONT_STACK}`
    ctx.fillStyle = TEXT_SECONDARY
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(qrCaption, gqrX + GQR / 2, gqrY + GQR + 10)
    ctx.textAlign = 'left'

    // 邀请 CTA(左下,QR 左侧留白)
    ctx.font = `500 14px ${POSTER_FONT_STACK}`
    ctx.fillStyle = TEXT_PRIMARY
    ctx.textBaseline = 'top'
    const ctaWidth = W - PADDING * 2 - GQR - 16
    ctx.save()
    ctx.beginPath()
    ctx.rect(PADDING, gqrY + 10, ctaWidth, 22 * 3)
    ctx.clip()
    drawWrappedText(ctx, ctaText, PADDING, gqrY + 10, ctaWidth, 22, 3, true)
    ctx.restore()
  } else {
    // ── 默认(名片)布局:居中 QR + 底部 CTA 条 ──
    const qrImg = images.get(opts.qrDataUrl)
    const QR_X = (W - QR_SIZE) / 2
    const QR_Y = 168
    ctx.fillStyle = '#ffffff'
    roundRect(ctx, QR_X - 8, QR_Y - 8, QR_SIZE + 16, QR_SIZE + 16, 10)
    ctx.fill()
    if (qrImg && qrImg.naturalWidth > 0) {
      ctx.drawImage(qrImg, QR_X, QR_Y, QR_SIZE, QR_SIZE)
    }
    ctx.font = `400 11px ${POSTER_FONT_STACK}`
    ctx.fillStyle = TEXT_SECONDARY
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(qrCaption, W / 2, QR_Y + QR_SIZE + 16 + 8)

    const CTA_Y = H - 52
    ctx.fillStyle = BG_TOP
    ctx.fillRect(0, CTA_Y, W, 52)
    ctx.font = `500 12px ${POSTER_FONT_STACK}`
    ctx.fillStyle = TEXT_SECONDARY
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(ctaText, PADDING, CTA_Y + 26)
  }

  // Accent corner bar
  ctx.fillStyle = ACCENT
  ctx.fillRect(0, 0, 3, H)

  // Reset
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  return canvas
}

/**
 * Async wrapper: waits for qrImg to load, then draws and returns the canvas.
 */
export async function createSharePosterCanvas(opts: PosterOptions): Promise<HTMLCanvasElement> {
  // @@@445 预载 QR + 所有成员头像为 HTMLImageElement，按 url 存 map 传给 drawSharePoster 直接 drawImage —
  // 不在 draw 时 new Image()(那样 complete 在非 Chromium/缓存竞态下不可靠,会画暗块占位)。
  const memberAvatarUrls = normalizePosterMemberAvatarUrls(opts.memberAvatarUrls ?? [])
  const urls = [opts.qrDataUrl, ...memberAvatarUrls.filter((url): url is string => !!url)]
  const loaded = await Promise.all(urls.map((u) => preloadImage(u)))
  const images = new Map<string, HTMLImageElement>()
  urls.forEach((u, i) => images.set(u, loaded[i]))
  return drawSharePoster({ ...opts, memberAvatarUrls }, images)
}

/** Encode PNG bytes before writing them; preserve the clipboard rejection. */
export async function copyPosterToClipboard(canvas: HTMLCanvasElement): Promise<void> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Could not encode poster as PNG')), 'image/png')
  })
  await writeImageBlobToClipboard(blob)
}

/**
 * Triggers a PNG download of the poster canvas.
 */
export function downloadPoster(canvas: HTMLCanvasElement, filename = 'gugu-share.png'): void {
  const url = canvas.toDataURL('image/png')
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// @@@445 返回已加载的 Image 元素本身(成功/失败都 resolve;失败时 naturalWidth=0,drawImage 侧记录诊断并画空槽)。
// 调用方直接用这个元素 drawImage,避免重新 new Image() 的 complete 不可靠问题。
function preloadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(img)
    img.src = src
  })
}

function drawEmptyMemberAvatar(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const center = size / 2
  ctx.beginPath()
  ctx.arc(x + center, y + center, size / 2, 0, Math.PI * 2)
  ctx.fillStyle = '#2a2a30'
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.32)'
  ctx.lineWidth = 1
  ctx.stroke()
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
  breakLatinWords = false,
): void {
  // @@@445 CJK-aware 分词:每个 CJK/全角字符各成一段(可在字间换行),非 CJK 连续段(含空格的拉丁词)整体成段。
  // 旧实现按 /\s+/ 切——纯 CJK 文本(如群名/「扫码加入群聊」)无空格→整串一段→永不换行、被直接省略号截断。
  // 用 \uXXXX 转义(别写字面全角字符:U+3000 全角空格会触发 no-irregular-whitespace)。
  const CJK = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff00-\\uffef'
  const pattern = breakLatinWords
    ? new RegExp(`[${CJK}]|[^\\s${CJK}]+\\s*|\\s+`, 'g')
    : new RegExp(`[${CJK}]|[^${CJK}]+`, 'g')
  const segments = text.match(pattern) ?? [text]
  let line = ''
  let lineCount = 0

  for (const seg of segments) {
    const testLine = line + seg
    const measured = ctx.measureText(testLine)
    if (measured.width > maxWidth && line.length > 0) {
      if (lineCount >= maxLines - 1) {
        // Ellipsize last line
        let ellipsized = line
        while (ctx.measureText(ellipsized + '…').width > maxWidth && ellipsized.length > 0) {
          ellipsized = ellipsized.slice(0, -1)
        }
        ctx.fillText(ellipsized + '…', x, y + lineCount * lineHeight)
        return
      }
      ctx.fillText(line, x, y + lineCount * lineHeight)
      line = seg
      lineCount++
    } else {
      line = testLine
    }
  }
  if (line && lineCount < maxLines) {
    ctx.fillText(line, x, y + lineCount * lineHeight)
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
