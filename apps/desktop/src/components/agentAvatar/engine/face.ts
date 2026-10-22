/**
 * face.ts —— 脸怎么画:眼睛(有上眼皮和睫毛线)、眉毛、腮红,外加眨眼怎么合上。
 * 全部画在一只眼睛的局部坐标里(单位 = 本体素材像素,y 向下),和身体同一个软网格、同一个头部球面,draw.ts setLocal 给出这个坐标系。
 * 表情只靠眼睛、眉毛、腮红和身体动作表达;喙不张开(owner 10-22:张鸟喙太丑,用脸颊颜色和眉毛)。
 *
 * 眼睛 = 一颗暖棕豆子 ∩ 上眼皮曲线 ∩ 下眼皮曲线(曲线见 spec.ts EyeShape)。上眼皮盖到眼睛上的那一段画一道睫毛线,
 * 眼皮越往下越粗;两条曲线合拢 = 闭眼,只剩那道线。另有三种闭着的画法:^ 笑弧(arc)、‒ 平线(flat)、> < 挤眼(chev)。
 */
import { TWO_PI, clamp, lerp } from './geometry'
import type { BrowShape, CheekShape, EyeShape } from './spec'

/** 睫毛线、眉毛:暖深棕,不用纯黑 */
const INK = '75,50,38'
/** 豆子(owner 2026-10-13 选定「圆润暖棕」,issue #7160):❌ 调回近乎纯黑 */
const BEAD = ['#85685a', '#4e362c', '#2a190f'] as const
/** 眼睛整体略小、竖椭圆放圆(同 #7160) */
export const EYE_SIZE_K = 0.96
export const EYE_ASPECT_K = 0.86

const lidV = (off: number, slope: number, bow: number, u: number, inner: number) => off + slope * inner * u + bow * (1 - u * u)

/**
 * 眨眼叠在任何眼睛上:上眼皮从它此刻的位置往下盖,中间顺着眼球往下弯;下眼皮往上迎一点,两条在中线稍下合成一道 ‿。
 * c = 0 睁 … 1 闭。笑弧 / 平线 / 挤眼本来就闭着,不眨。
 */
export function blinkEye(e: EyeShape, c: number, out: EyeShape): EyeShape {
  Object.assign(out, e)
  if (c <= 0 || e.arc > 0.05 || e.flat > 0.95 || e.chev > 0.5) return out
  const meet = clamp(e.bOff + e.bBow, 0.15, 0.42)
  const c2 = c * c
  out.tOff = lerp(e.tOff, meet - 0.26, c)
  out.tBow = lerp(e.tBow, 0.3, c)
  out.tSlope = e.tSlope * (1 - c)
  out.bOff = lerp(e.bOff, meet + 0.02, c2)
  out.bBow = lerp(e.bBow, 0.26, c2)
  out.bSlope = e.bSlope * (1 - c)
  out.size = e.size * (1 - 0.04 * c)
  return out
}

/** 一帧里闭眼的程度:合 70ms(加速)→ 合着停 40ms → 睁 150ms(减速)。dt = 这次眨眼开始后的秒数 */
export function blinkCurve(dt: number): number {
  if (dt < 0) return 0
  if (dt < 0.07) return (dt / 0.07) ** 2
  if (dt < 0.11) return 1
  if (dt < 0.26) return (1 - (dt - 0.11) / 0.15) ** 3
  return 0
}
export const BLINK_SHUT = 0.07
export const BLINK_LEN = 0.26

const scratch: EyeShape = { size: 1, tOff: 0, tSlope: 0, tBow: 0, bOff: 0, bSlope: 0, bBow: 0, arc: 0, flat: 0, chev: 0 }

/**
 * 画一只眼睛。r = 眼宽方向半径、asp = 高/宽(素材像素);gloss 高光位置;gx/gy 高光随视线;small = 小于 70 CSS px 的头像。
 * 一个局部单位在画布上多少设备像素从当前变换读出:线最细 1 个设备像素,小头像也看得见。
 */
export function drawEye(
  ctx: CanvasRenderingContext2D,
  shape: EyeShape,
  inner: number,
  r0: number,
  asp: number,
  alpha: number,
  gloss: { x: number; y: number; r: number },
  gx: number,
  gy: number,
  small: boolean,
  socket: number
) {
  if (alpha < 0.02) return
  let e = shape
  // 笑弧和睁眼之间没有「半个笑弧」:从笑弧睁开 = 一次眨眼的后半段
  if (e.arc > 0 && e.arc < 0.5) e = blinkEye({ ...e, arc: 0 }, e.arc / 0.5, scratch)
  const r = r0 * e.size
  if (r < 0.5) return
  const m = ctx.getTransform()
  const unit = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
  const minW = 1.15 / unit
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = `rgb(${INK})`

  if (e.chev > 0.5) {
    // > < :尖朝鼻梁
    const o = -inner * 0.78
    ctx.lineWidth = Math.max(r * 0.25, minW * 1.3)
    ctx.beginPath()
    ctx.moveTo(o * r, -0.5 * r * asp)
    ctx.lineTo(inner * 0.62 * r, 0.02 * r * asp)
    ctx.lineTo(o * r, 0.5 * r * asp)
    ctx.stroke()
    ctx.restore()
    return
  }
  if (e.arc >= 0.5) {
    // ^ 笑弧:一道粗软的弧,两头略低于中线
    const k = Math.min(e.arc, 1.2)
    ctx.lineWidth = Math.max(r * 0.27, minW * 1.3)
    ctx.beginPath()
    for (let i = 0; i <= 20; i++) {
      const u = -0.88 + (1.76 * i) / 20
      const y = (0.22 - k * 0.62 * (1 - u * u)) * r * asp
      if (i === 0) ctx.moveTo(u * r, y)
      else ctx.lineTo(u * r, y)
    }
    ctx.stroke()
    ctx.restore()
    return
  }

  if (e.flat > 0 && e.flat < 1) {
    // 合成平线 = 两条眼皮都走到那条线上(一次闭了不再睁的眨眼),❌ 一颗半透明的豆子
    const f = e.flat
    e = { ...e, tOff: lerp(e.tOff, 0.04, f), tBow: e.tBow * (1 - f), tSlope: e.tSlope * (1 - f), bOff: lerp(e.bOff, 0.2, f), bBow: e.bBow * (1 - f), bSlope: e.bSlope * (1 - f), flat: f > 0.85 ? 1 : 0 }
  }
  const vTop = (u: number) => lidV(e.tOff, e.tSlope, e.tBow, u, inner)
  const vLow = (u: number) => lidV(e.bOff, e.bSlope, e.bBow, u, inner)
  let gap = 9
  for (let i = 0; i <= 8; i++) {
    const u = -0.7 + (1.4 * i) / 8
    gap = Math.min(gap, vLow(u) - vTop(u))
  }
  const closed = Math.max(e.flat, 1 - clamp(gap / 0.16))

  // 豆子嵌在毛里的暗圈:只在两条眼皮都离开豆子时(下眼皮托起来那里是脸颊的毛)
  const sockK = clamp((e.bOff + e.bBow - 0.95) / 0.3) * clamp((-e.tOff - 0.95) / 0.3)
  if (closed < 0.999 && !small && sockK > 0.01) {
    const vis = (1 - closed) * sockK * socket
    ctx.save()
    ctx.scale(1, asp)
    const g = ctx.createRadialGradient(0.05 * r, 0.09 * r, r * 0.8, 0.05 * r, 0.09 * r, r * 1.5)
    g.addColorStop(0, `rgba(84,66,58,${0.5 * vis})`)
    g.addColorStop(0.45, `rgba(96,78,70,${0.2 * vis})`)
    g.addColorStop(1, 'rgba(96,78,70,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0.05 * r, 0.09 * r, r * 1.5, 0, TWO_PI)
    ctx.fill()
    ctx.restore()
  }

  if (closed < 0.999) {
    ctx.save()
    ctx.scale(1, asp)
    ctx.beginPath()
    ctx.ellipse(0, 0, r, r, 0, 0, TWO_PI)
    ctx.clip()
    ctx.beginPath()
    const N = 18
    for (let k = 0; k <= N; k++) {
      const u = -1.2 + (2.4 * k) / N
      if (k === 0) ctx.moveTo(u * r, vTop(u) * r)
      else ctx.lineTo(u * r, vTop(u) * r)
    }
    for (let k = N; k >= 0; k--) {
      const u = -1.2 + (2.4 * k) / N
      ctx.lineTo(u * r, vLow(u) * r)
    }
    ctx.closePath()
    ctx.clip()
    ctx.globalAlpha = alpha * (1 - closed)
    const bead = ctx.createRadialGradient(-0.3 * r, -0.34 * r, 0, -0.1 * r, -0.1 * r, 1.25 * r)
    bead.addColorStop(0, BEAD[0])
    bead.addColorStop(0.28, BEAD[1])
    bead.addColorStop(1, BEAD[2])
    ctx.fillStyle = bead
    ctx.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6)
    const rim = ctx.createRadialGradient(0.42 * r, 0.5 * r, 0, 0.42 * r, 0.5 * r, 0.7 * r)
    rim.addColorStop(0, 'rgba(255,225,205,0.30)')
    rim.addColorStop(1, 'rgba(150,150,165,0)')
    ctx.fillStyle = rim
    ctx.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6)
    const glow = ctx.createRadialGradient(0.12 * r, 0.62 * r, 0, 0.12 * r, 0.62 * r, 0.95 * r)
    glow.addColorStop(0, 'rgba(255,205,190,0.35)')
    glow.addColorStop(1, 'rgba(255,205,190,0)')
    ctx.fillStyle = glow
    ctx.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6)
    // 高光:任何尺寸都画(owner 10-13),但不超过豆子的一半 —— 32px 的眼睛只有两三个像素,高光一大眼睛就成了白圈
    ctx.scale(1, 1 / asp)
    const hx = (gloss.x + gx * 0.1) * r
    const hy = (gloss.y * asp + gy * 0.1) * r
    const hR = Math.min(Math.max(gloss.r * 1.6 * r, 1.6 / unit), 0.42 * r)
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hR)
    hg.addColorStop(0, 'rgba(255,255,255,0.86)')
    hg.addColorStop(0.5, 'rgba(255,255,255,0.7)')
    hg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = hg
    ctx.beginPath()
    ctx.arc(hx, hy, hR, 0, TWO_PI)
    ctx.fill()
    if (!small) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.beginPath()
      ctx.arc((0.32 + gx * 0.06) * r, (0.36 * asp + gy * 0.06) * r, 0.1 * r, 0, TWO_PI)
      ctx.fill()
    }
    ctx.restore()
  }

  // 睫毛线:上眼皮盖在眼睛上的那一段;眼皮越往下越粗,合上时就是那一道 ‿
  const lidShow = clamp((e.tOff + 1.02) / 0.5)
  if (lidShow > 0.01 || closed > 0.01) {
    ctx.beginPath()
    let n = 0
    for (let k = 0; k <= 24; k++) {
      const u = -1.05 + (2.1 * k) / 24
      let v = closed > 0.5 ? (vTop(u) + vLow(u)) / 2 : vTop(u)
      if (e.flat > 0) v = lerp(v, 0.12, e.flat)
      if (u * u + v * v > 1.06 && closed <= 0.5) continue
      const x = u * r * (closed > 0.5 ? 0.97 : 1),
        y = v * r * asp
      if (n++ === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    if (n > 1) {
      const k = Math.max(lidShow, closed, e.flat)
      ctx.lineWidth = Math.max(r * lerp(0.1, 0.2, Math.max(closed, e.flat)) * Math.max(lidShow, closed), minW * k)
      ctx.globalAlpha = alpha
      ctx.stroke()
    }
  }
  ctx.restore()
}

/**
 * 眉毛:眼睛上方一道短而圆头的豆豆眉,靠鼻梁一侧略粗(鼻梁侧 = u·inner > 0)。
 * 小头像(small)里平常的眉毛只是两个多出来的黑点:只在眉毛真在表情(明显抬高 / 压低 / 倾斜)时才画。
 */
export function drawBrow(ctx: CanvasRenderingContext2D, b: BrowShape, inner: number, r: number, asp: number, alpha: number, small: boolean) {
  const says = clamp((Math.abs(b.lift) - 0.12) / 0.2 + Math.abs(b.tilt) / 0.25)
  const a = alpha * b.on * (small ? 0.85 * says : 1)
  if (a < 0.02) return
  const m = ctx.getTransform()
  const unit = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
  const y0 = -(1.48 + b.lift) * r * asp
  const half = 0.56
  const thick = Math.max(r * 0.26, 1.3 / unit)
  ctx.save()
  ctx.globalAlpha = a * 0.82
  ctx.fillStyle = `rgb(${INK})`
  ctx.beginPath()
  const N = 14
  const xs: number[] = [],
    ys: number[] = [],
    ts: number[] = []
  for (let i = 0; i <= N; i++) {
    const s = -1 + (2 * i) / N
    xs.push(s * half * r - 0.05 * r * inner)
    ys.push(y0 - b.arch * 0.32 * r * (1 - s * s) - b.tilt * 0.42 * r * s * inner)
    ts.push(thick * (0.55 + 0.45 * Math.sin(Math.PI * (0.5 + 0.5 * s))) * (1 + 0.25 * s * inner))
  }
  for (let i = 0; i <= N; i++) i ? ctx.lineTo(xs[i], ys[i] - ts[i] / 2) : ctx.moveTo(xs[i], ys[i] - ts[i] / 2)
  for (let i = N; i >= 0; i--) ctx.lineTo(xs[i], ys[i] + ts[i] / 2)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/** 腮红:眼睛下方偏外侧;笑的时候被脸颊顶上去(lift);大笑在大头像上加三道短红晕线 */
export function drawCheek(ctx: CanvasRenderingContext2D, c: CheekShape, k: number, inner: number, r: number, asp: number, alpha: number, small: boolean) {
  const a = k * alpha
  if (a < 0.02) return
  const m = ctx.getTransform()
  const unit = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
  const rx = Math.max(1.05 * r * c.wide, 2.2 / unit)
  ctx.save()
  ctx.translate(-inner * 0.42 * r, (1.42 - 0.45 * c.lift) * r * asp)
  ctx.save()
  ctx.scale(1, 0.55)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  g.addColorStop(0, `rgba(250,120,118,${0.62 * a})`)
  g.addColorStop(0.55, `rgba(252,132,128,${0.34 * a})`)
  g.addColorStop(1, 'rgba(255,150,140,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
  if (c.lines > 0.02 && !small) {
    ctx.strokeStyle = `rgba(214,92,96,${0.75 * c.lines * alpha})`
    ctx.lineWidth = Math.max(0.09 * r, 1 / unit)
    ctx.lineCap = 'round'
    for (let i = -1; i <= 1; i++) {
      const x = i * 0.36 * r
      ctx.beginPath()
      ctx.moveTo(x + 0.12 * r, -0.2 * r)
      ctx.lineTo(x - 0.12 * r, 0.2 * r)
      ctx.stroke()
    }
  }
  ctx.restore()
}
