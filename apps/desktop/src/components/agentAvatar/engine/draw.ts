/**
 * draw.ts —— 一帧头像怎么画：底色 → 各形态层（由下到上：落地影 → 部件软网格（WebGL）→ 脸红 → 眼睛）→ 特效
 * 不画任何旁挂的状态零件：展示状态由身体自己变形表达（forms.ts），形态的画面是设计稿出图抠下来的素材。
 * 眼睛/腮红经过它所在部件的同一个 warp 与摆放，身体怎么挤、怎么歪、怎么滚，它们就怎么跟。
 * 装扮(outfits.ts)是另一层,穿插在这几步之间:back 在部件前、mid 在部件后眼睛前、top 在眼睛后(第二趟 GL)。
 */
import { BodyParams, TWO_PI, clamp, warp, warpWith, warpWeights, type WarpWeights } from './geometry'
import { GRID_X, GRID_Y, GuguGL } from './gl'
import type { EyeOut, GuguFrame, Layer, Particle } from './engine'
import type { Character, Pack } from './characters'
import type { Part } from './forms'
import type { OutfitDraw } from './outfits'

export type FrameShape = 'circle' | 'squircle' | 'free'
export type Crop = 'full' | 'bust'

export interface DrawOpts {
  w: number // 画布像素（已乘 dpr）
  h: number
  shape: FrameShape
  bg: boolean // 薄荷底
  crop: Crop
  fx: boolean // 画特效
  dpr: number
}

export interface View {
  s: number
  ox: number
  oy: number
}

/**
 * 取景：A 的老数字（975 / 470 / 974 / 25）现在是各角色包的 view{ref, cx, bottom, top}；半身取景 bustFill 控制放多大。
 * 戴着装扮时把它们也装进来:头上的帽子(head)、脚下的滑板(lift)让整只缩一点,头顶 / 地面那条线不动;手里的伞(hw)横向装不下再缩
 */
function viewFor(w: number, h: number, crop: Crop, shape: FrameShape, ch: Character, outfit: OutfitDraw | null = null): View {
  const v = ch.view
  const head = outfit ? outfit.viewHead() : 0
  const lift = outfit ? outfit.viewLift(crop) : 0
  const groundY = h * (shape === 'free' ? 0.94 : 0.925)
  let view: View
  if (crop === 'bust') {
    const s = (h * v.bustFill) / (v.ref + head)
    view = { s, ox: w / 2 - v.cx * s, oy: h * 0.07 - (v.top - head) * s }
  } else {
    const fill = shape === 'free' ? 0.84 : 0.8
    const s = (h * fill) / (v.ref + lift + head)
    view = { s, ox: w / 2 - v.cx * s, oy: groundY - (v.bottom + lift) * s }
  }
  const hw = outfit ? outfit.viewHalfWidth() : 0
  const s = hw > 0 ? Math.min(view.s, w / 2 / hw) : view.s
  if (s >= view.s) return view
  const gy = crop === 'bust' ? h * 0.07 : groundY // 不动的那条线
  return { s, ox: w / 2 - v.cx * s, oy: gy - (gy - view.oy) * (s / view.s) }
}

const TEAL = '#2d7a64'
const tmp: [number, number] = [0, 0]
const tmp1: [number, number] = [0, 0]
const tmp2: [number, number] = [0, 0]

type MeshPoint = WarpWeights & { x: number; y: number }

// All avatars sharing a sprite pack share its fixed grid; animated outfit anchors stay dynamic.
const meshes = new WeakMap<Pack, MeshPoint[]>()
function meshFor(pack: Pack): MeshPoint[] {
  let mesh = meshes.get(pack)
  if (!mesh) {
    mesh = []
    for (let j = 0; j <= GRID_Y; j++) {
      const y = (j / GRID_Y) * pack.spr.h
      for (let i = 0; i <= GRID_X; i++) {
        const x = (i / GRID_X) * pack.spr.w
        mesh.push(Object.assign(warpWeights(x, y, pack), { x, y }))
      }
    }
    meshes.set(pack, mesh)
  }
  return mesh
}

function framePath(ctx: CanvasRenderingContext2D, w: number, h: number, shape: FrameShape) {
  ctx.beginPath()
  if (shape === 'circle') {
    ctx.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, TWO_PI)
  } else {
    const r = Math.min(w, h) * 0.225
    ctx.moveTo(r, 0)
    ctx.arcTo(w, 0, w, h, r)
    ctx.arcTo(w, h, 0, h, r)
    ctx.arcTo(0, h, 0, 0, r)
    ctx.arcTo(0, 0, w, 0, r)
    ctx.closePath()
  }
}

function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, ch: Character) {
  // A：取自 V1 实测底色（中调 136,213,178，右上略亮）；fjj：同一族薄荷，略浅略暖，托得住奶黄色身体
  const g = ctx.createRadialGradient(
    w * 0.66,
    h * 0.26,
    0,
    w * 0.55,
    h * 0.42,
    Math.max(w, h) * 0.95
  )
  g.addColorStop(0, ch.backdrop[0])
  g.addColorStop(0.5, ch.backdrop[1])
  g.addColorStop(1, ch.backdrop[2])
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
}

/** 落地影：贴在部件的落地点，离地越高越小越淡。有薄荷底时是深青色；没底（透明贴在界面上）时用中性灰、淡一点 */
function drawPartShadow(
  ctx: CanvasRenderingContext2D,
  v: View,
  p: Part,
  alpha: number,
  bg: boolean
) {
  if (!p.shOn || alpha < 0.01) return
  const hopN = p.hopN
  const cx = v.ox + p.shx * v.s
  const cy = v.oy + p.shy * v.s
  const rx = Math.max(1, p.shrx * v.s * (1 - 0.28 * hopN))
  const ry = Math.max(0.5, p.shry * v.s * (1 - 0.3 * hopN))
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, ry / rx)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  const a = (bg ? 0.34 : 0.2) * (1 - 0.55 * hopN) * alpha
  const c = bg ? '24,86,66' : '40,40,44'
  g.addColorStop(0, `rgba(${c},${a})`)
  g.addColorStop(0.55, `rgba(${c},${a * 0.55})`)
  g.addColorStop(1, `rgba(${c},0)`)
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
}

/** 素材坐标 (x, y)（部件自己的素材里的一点）→ 世界：先软网格变形，再绕落地点旋转、缩放、平移到摆放位置 */
export function place(x: number, y: number, p: Part, body: BodyParams, out: [number, number]) {
  warp(x, y, body, out, p.pack)
  placeWarped(p, out)
}

function placeWarped(p: Part, out: [number, number]) {
  const dx = out[0] - p.pack.pivot.x,
    dy = out[1] - p.pack.pivot.y
  if (p.rot === 0) {
    out[0] = p.gx + dx * p.sc
    out[1] = p.gy + dy * p.sc
  } else {
    const c = Math.cos(p.rot),
      s = Math.sin(p.rot)
    out[0] = p.gx + (dx * c - dy * s) * p.sc
    out[1] = p.gy + (dx * s + dy * c) * p.sc
  }
}

/** 局部（眼睛/腮红坐标系，单位=部件素材像素）→ 画布 的矩阵 */
function setLocal(ctx: CanvasRenderingContext2D, e: EyeOut, p: Part, v: View) {
  const body = p.bodyE
  place(e.cx, e.cy, p, body, tmp)
  const X0 = tmp[0],
    Y0 = tmp[1]
  place(e.cx + 1, e.cy, p, body, tmp1)
  place(e.cx, e.cy + 1, p, body, tmp2)
  const j00 = tmp1[0] - X0,
    j10 = tmp1[1] - Y0
  const j01 = tmp2[0] - X0,
    j11 = tmp2[1] - Y0
  const m00 = j00 * e.ax + j01 * e.ay
  const m10 = j10 * e.ax + j11 * e.ay
  const m01 = j00 * e.bx + j01 * e.by
  const m11 = j10 * e.bx + j11 * e.by
  ctx.setTransform(m00 * v.s, m10 * v.s, m01 * v.s, m11 * v.s, v.ox + X0 * v.s, v.oy + Y0 * v.s)
}

function drawBlush(ctx: CanvasRenderingContext2D, e: EyeOut, k: number) {
  if (k < 0.02) return
  const r = e.r
  ctx.save()
  ctx.translate(0, r * (1.1 + 0.85 * e.aspect))
  ctx.scale(1, 0.52)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.5)
  g.addColorStop(0, `rgba(255,118,128,${0.5 * k * e.alpha})`)
  g.addColorStop(0.6, `rgba(255,128,138,${0.22 * k * e.alpha})`)
  g.addColorStop(1, 'rgba(255,140,150,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, r * 1.5, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
}

const lidV = (off: number, slope: number, bow: number, up: number, inner: number) =>
  off + slope * inner * up + bow * (1 - up * up)

/**
 * 眼睛的画法(owner 2026-10-13 选定「圆润暖棕」,issue #7160)。
 * 用户反馈「眼珠太黑、不可爱」:原来是又大又黑又亮的竖椭圆,配一个白高光,读成玩偶式「直勾勾」;小尺寸里连高光都没有,
 * 读成一个黑洞。所以:放圆(不再是竖椭圆)、略小、颜色换成带暖色的栗棕,任何尺寸都有一个看得见的高光。
 * ❌ 不要把黑豆再调回近乎纯黑,也不要把高光在小尺寸里关掉。
 */
const EYE = {
  bead: ['#85685a', '#4e362c', '#2a190f'] as const, // 豆子渐变:左上亮区 / 中段 / 边缘
  rim: 'rgba(255,225,205,0.30)', // 右下一圈弱反光
  glossK: 1.6, // 主高光半径 = character.eye.gloss.r × glossK
  glossA: 0.9, // 主高光的浓度
  glossMinPx: 2.4, // 主高光半径下限(设备像素):小头像里也看得见
  spark: { r: 0.1, a: 0.45 }, // 次高光
  glow: 0.35, // 下缘一抹暖光:栗棕里透一点光,像玻璃珠,不是一块黑
  sizeK: 0.96, // 眼睛整体略小
  aspectK: 0.86 // 纵横比倍数:fjj 的眼睛是竖椭圆,放圆
}

/** 画一只眼睛。导出只为单测直接喂假画布(draw.ts 其余部分依赖 WebGL)。 */
export function drawEye(
  ctx: CanvasRenderingContext2D,
  e: EyeOut,
  small: boolean,
  gloss: Character['eye']['gloss'],
  socket: number
) {
  const sh = e.shape
  const r = e.r * sh.size * EYE.sizeK
  if (e.alpha < 0.02 || r < 1) return
  const N = 16
  const asp = e.aspect * EYE.aspectK

  // 睁眼程度：决定"豆眼窝"那圈暗影有多重（闭成月牙时淡掉）
  const mid = 0.5 * (sh.bOff + sh.bBow - (sh.tOff + sh.tBow))
  const vis = clamp((mid - 0.55) / 1.0)

  // 以下全在「宽 = r、高 = r·asp」的椭圆坐标里画：圆眼 asp=1，fjj 的竖椭圆眼 asp>1；眼睑曲线的纵向单位也随之变成眼高
  ctx.save()
  ctx.scale(1, asp)

  // 豆子嵌在毛里的暗圈
  if (vis > 0.05 && !small) {
    const g = ctx.createRadialGradient(0.05 * r, 0.09 * r, r * 0.8, 0.05 * r, 0.09 * r, r * 1.5)
    g.addColorStop(0, `rgba(84,66,58,${0.5 * vis * e.alpha * socket})`)
    g.addColorStop(0.45, `rgba(96,78,70,${0.2 * vis * e.alpha * socket})`)
    g.addColorStop(1, 'rgba(96,78,70,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0.05 * r, 0.09 * r, r * 1.5, 0, TWO_PI)
    ctx.fill()
  }

  ctx.globalAlpha = e.alpha
  ctx.beginPath()
  ctx.ellipse(0, 0, r * (1 + 0.15 * (1 - vis)), r * (1 + 0.15 * (1 - vis)), 0, 0, TWO_PI) // 闭成弧时外圈放宽一点，弧的两头才圆润不被削尖
  ctx.clip()
  // 眼睑夹出的可见区域：上线→下线
  ctx.beginPath()
  for (let k = 0; k <= N; k++) {
    const up = -1.5 + (3 * k) / N
    const y = lidV(sh.tOff, sh.tSlope, sh.tBow, up, e.inner) * r
    if (k === 0) ctx.moveTo(up * r, y)
    else ctx.lineTo(up * r, y)
  }
  for (let k = N; k >= 0; k--) {
    const up = -1.5 + (3 * k) / N
    ctx.lineTo(up * r, lidV(sh.bOff, sh.bSlope, sh.bBow, up, e.inner) * r)
  }
  ctx.closePath()
  ctx.clip()

  // 黑豆：上左一团柔光，右下一圈弱反光
  const bead = ctx.createRadialGradient(-0.3 * r, -0.34 * r, 0, -0.1 * r, -0.1 * r, 1.25 * r)
  bead.addColorStop(0, EYE.bead[0])
  bead.addColorStop(0.28, EYE.bead[1])
  bead.addColorStop(1, EYE.bead[2])
  ctx.fillStyle = bead
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4)
  const rim = ctx.createRadialGradient(0.42 * r, 0.5 * r, 0, 0.42 * r, 0.5 * r, 0.7 * r)
  rim.addColorStop(0, EYE.rim)
  rim.addColorStop(1, 'rgba(150,150,165,0)')
  ctx.fillStyle = rim
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4)

  // 下缘一抹暖光
  const gg = ctx.createRadialGradient(0.12 * r, 0.62 * r, 0, 0.12 * r, 0.62 * r, 0.95 * r)
  gg.addColorStop(0, `rgba(255,205,190,${EYE.glow})`)
  gg.addColorStop(1, 'rgba(255,205,190,0)')
  ctx.fillStyle = gg
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4)

  {
    // 高光(任何尺寸都画;小头像里靠 glossMinPx 保证看得见)。画成正圆（抵消纵向拉伸）；位置的纵向以眼高为单位
    ctx.scale(1, 1 / asp)
    const m = ctx.getTransform()
    const devPerUnit = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
    const hx = (gloss.x + e.gx * 0.1) * r
    const hy = (gloss.y * asp + e.gy * 0.1) * r
    const hR = Math.max(gloss.r * EYE.glossK * r, EYE.glossMinPx / devPerUnit)
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hR)
    hg.addColorStop(0, `rgba(255,255,255,${0.96 * EYE.glossA})`)
    hg.addColorStop(0.5, `rgba(255,255,255,${0.78 * EYE.glossA})`)
    hg.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = hg
    ctx.beginPath()
    ctx.arc(hx, hy, hR, 0, TWO_PI)
    ctx.fill()
    // 次高光
    const sx = (0.32 + e.gx * 0.06) * r
    const sy = (0.36 * asp + e.gy * 0.06) * r
    ctx.fillStyle = `rgba(255,255,255,${EYE.spark.a})`
    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(EYE.spark.r * r, (EYE.glossMinPx * 0.5) / devPerUnit), 0, TWO_PI)
    ctx.fill()
  }
  ctx.restore()
}

// ───────────── 特效 ─────────────
function sparkPath(ctx: CanvasRenderingContext2D, R: number) {
  const r = R * 0.22
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 - Math.PI / 2
    const rr = i % 2 === 0 ? R : r
    const x = Math.cos(a) * rr,
      y = Math.sin(a) * rr
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function drawParticle(
  ctx: CanvasRenderingContext2D,
  p: Particle,
  t: number,
  body: BodyParams,
  v: View,
  ch: Character
) {
  const age = t - p.born
  const u = clamp(age / p.life)
  const px = p.x + p.vx * age,
    py = p.y + p.vy * age
  let wx = px,
    wy = py
  if (p.w) {
    warp(px, py, body, tmp, ch)
    wx = tmp[0]
    wy = tmp[1]
  } // 生在本体上的跟着软网格走；生在形态上的按世界坐标
  const x = v.ox + wx * v.s
  const y = v.oy + wy * v.s
  const fade = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.0)), 0.55)
  ctx.save()
  ctx.translate(x, y)
  switch (p.kind) {
    case 'z': {
      ctx.rotate(p.rot)
      ctx.globalAlpha = fade * 0.9
      ctx.fillStyle = TEAL
      ctx.font = `800 ${Math.round(58 * v.s * p.s * (0.7 + 0.5 * u))}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(p.glyph ?? 'z', 0, 0)
      break
    }
    case 'spark': {
      const R = 40 * v.s * p.s * Math.sin(Math.PI * u)
      ctx.rotate(p.rot + u * 0.8)
      ctx.globalAlpha = 0.95
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.6)
      g.addColorStop(0, 'rgba(255,230,150,0.6)')
      g.addColorStop(1, 'rgba(255,230,150,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(0, 0, R * 1.6, 0, TWO_PI)
      ctx.fill()
      ctx.fillStyle = '#fff3c2'
      sparkPath(ctx, R)
      ctx.fill()
      break
    }
    case 'bang':
    case 'ques': {
      const pop = u < 0.18 ? 0.35 + (u / 0.18) * 0.95 : 1.3 - 0.3 * clamp((u - 0.18) / 0.2)
      ctx.rotate(p.rot)
      ctx.globalAlpha = u > 0.72 ? 1 - (u - 0.72) / 0.28 : 1
      ctx.fillStyle = TEAL
      ctx.font = `800 ${Math.round(112 * v.s * pop)}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(p.glyph ?? '!', 0, 0)
      break
    }
    case 'sweat': {
      ctx.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1
      const R = 22 * v.s
      ctx.fillStyle = 'rgba(176,222,255,0.96)'
      ctx.strokeStyle = 'rgba(80,140,190,0.7)'
      ctx.lineWidth = Math.max(1, 3 * v.s)
      ctx.beginPath()
      ctx.moveTo(0, -R * 1.7)
      ctx.bezierCurveTo(R * 1.1, -R * 0.2, R * 0.95, R, 0, R)
      ctx.bezierCurveTo(-R * 0.95, R, -R * 1.1, -R * 0.2, 0, -R * 1.7)
      ctx.fill()
      ctx.stroke()
      break
    }
    default: {
      // dots
      const R = 11 * v.s
      ctx.fillStyle = TEAL
      for (let i = 0; i < 3; i++) {
        const on = clamp(u * 3.4 - i * 0.55)
        ctx.globalAlpha = Math.min(on, u > 0.8 ? 1 - (u - 0.8) / 0.2 : 1) * 0.9
        ctx.beginPath()
        ctx.arc((i - 1) * R * 3, 0, R, 0, TWO_PI)
        ctx.fill()
      }
    }
  }
  ctx.restore()
}

// ───────────── 主入口 ─────────────
/** paintGL 画好的各趟在共用 GL 画布上的格子(左上角 x, y 依次排),drawAvatar 按同样的次序取 */
export interface Slots {
  at: number[]
  next: number
}

function copySlot(ctx: CanvasRenderingContext2D, gl: GuguGL, slots: Slots, w: number, h: number) {
  const x = slots.at[slots.next++]
  const y = slots.at[slots.next++]
  ctx.drawImage(gl.canvas, x, y, w, h, 0, 0, w, h)
}

/** 这一只要在 GL 里画几趟:每层一趟,戴着盖在眼睛上面的装扮再加一趟(走法同 paintGL) */
export function glPasses(f: GuguFrame, outfit: OutfitDraw | null): number {
  let n = 0
  for (const L of f.layers) if (L.alpha > 0.004) n += outfit && outfit.has(L, 'top') ? 2 : 1
  return n
}

/**
 * 头一半:这一只的身体与装扮在共用 GL 画布上各占一格画好(gl.room() 先问过)。同一批的几只都画完了,
 * 再各自 drawAvatar 把格子抄到自己的画布上、叠上眼睛与脸红。
 */
export function paintGL(gl: GuguGL, f: GuguFrame, o: DrawOpts, outfit: OutfitDraw | null): Slots {
  const { w, h } = o
  const v = viewFor(w, h, o.crop, o.shape, f.ch, outfit)
  const at: number[] = []
  for (const L of f.layers) {
    if (L.alpha <= 0.004) continue
    const lay = f.alpha * L.alpha
    const parts = L.parts
    at.push(...gl.begin(w, h))
    outfit?.mesh(gl, f, L, v, o, 'back')
    const verts = gl.verts
    for (let pi = 0; pi < parts.n; pi++) {
      const p = parts.list[pi]
      const mesh = meshFor(p.pack)
      let k = 0
      for (const point of mesh) {
        warpWith(point.x, point.y, p.body, tmp, p.pack, point)
        placeWarped(p, tmp)
        verts[k++] = v.ox + tmp[0] * v.s
        verts[k++] = v.oy + tmp[1] * v.s
      }
      gl.drawSprite(p.pack.id, f.desat, f.dim, lay * p.alpha, f.tint)
    }
    outfit?.mesh(gl, f, L, v, o, 'mid')
    if (outfit && outfit.has(L, 'top')) {
      at.push(...gl.begin(w, h))
      outfit.mesh(gl, f, L, v, o, 'top')
    }
  }
  return { at, next: 0 }
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  gl: GuguGL | null,
  sprite: HTMLImageElement | null,
  f: GuguFrame,
  L: Layer,
  v: View,
  o: DrawOpts,
  outfit: OutfitDraw | null,
  slots: Slots
) {
  const { w, h } = o
  const ch = f.ch
  const parts = L.parts
  const lay = f.alpha * L.alpha
  const shK = outfit ? outfit.shadowK(o.crop) : 1
  for (let i = 0; i < parts.n; i++)
    drawPartShadow(ctx, v, parts.list[i], lay * parts.list[i].alpha * shK, o.bg)
  outfit?.shadow2d(ctx, f, L, v, o)
  const flatBody = !gl && sprite !== null && sprite.complete && sprite.naturalWidth > 0 && parts.list[0].pack.id === ch.id

  if (gl) {
    copySlot(ctx, gl, slots, w, h)
  } else if (flatBody) {
    // 无 WebGL 的退路：只画本体，只做整体挤压/跳起(图坏了就不画:drawImage 一张坏图会抛错,整帧后面的头像全跟着停);装扮同样整张贴
    const p = parts.list[0]
    outfit?.flat(ctx, f, L, v, o, 'back')
    ctx.save()
    ctx.globalAlpha = lay
    ctx.translate(v.ox + ch.pivot.x * v.s, v.oy + (ch.pivot.y - p.body.hop) * v.s)
    ctx.scale(p.body.sx, p.body.sy)
    ctx.drawImage(sprite, -ch.pivot.x * v.s, -ch.pivot.y * v.s, ch.spr.w * v.s, ch.spr.h * v.s)
    ctx.restore()
    outfit?.flat(ctx, f, L, v, o, 'mid')
  }

  // 脸红 + 眼睛（在眼睛部件的局部坐标系里画）
  const ep = parts.list[L.eye.part]
  const eye = ep.pack.eye
  const small = Math.min(w, h) < 70 * o.dpr
  for (const e of L.eyes) {
    setLocal(ctx, e, ep, v)
    drawBlush(ctx, e, f.blush)
  }
  for (const e of L.eyes) {
    setLocal(ctx, e, ep, v)
    drawEye(ctx, e, small, eye.gloss, eye.socket)
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  // 盖在眼睛上面的装扮(帽子、眼镜、耳机):GL 再走一趟、再抄一次;2D 定格照样整张贴
  if (outfit && outfit.has(L, 'top')) {
    if (gl) {
      copySlot(ctx, gl, slots, w, h)
    } else if (flatBody) {
      outfit.flat(ctx, f, L, v, o, 'top')
    }
  }
}

/** 后一半:把 paintGL 画好的格子抄到这只自己的画布上,叠上影子、眼睛、脸红、特效。gl = null 走 2D 定格(slots 不用) */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  gl: GuguGL | null,
  sprite: HTMLImageElement | null,
  f: GuguFrame,
  o: DrawOpts,
  outfit: OutfitDraw | null,
  slots: Slots
) {
  const { w, h } = o
  const ch = f.ch
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, w, h)
  const v = viewFor(w, h, o.crop, o.shape, ch, outfit)

  ctx.save()
  if (o.shape !== 'free') {
    framePath(ctx, w, h, o.shape)
    ctx.clip()
  }
  if (o.bg) drawBackdrop(ctx, w, h, ch)
  // 由下到上：旧形态在下面淡出，当前形态在上面
  for (const L of f.layers) if (L.alpha > 0.004) drawLayer(ctx, gl, sprite, f, L, v, o, outfit, slots)

  const small = Math.min(w, h) < 70 * o.dpr
  if (o.fx && !small) {
    // 生在本体上的特效跟本体的软网格走（脸区滑动不算：它会把局部坐标剪歪）
    const body = f.body.fx === 0 && f.body.fy === 0 ? f.body : { ...f.body, fx: 0, fy: 0 }
    for (const p of f.particles) drawParticle(ctx, p, f.time, body, v, ch)
  }
  ctx.restore()
}

/** 外形取样点:每个部件素材上 3×3 个点(四角、四边中点、中心),走和画网格同一个 place() */
const LOOK_GRID = [0, 0.5, 1]

/**
 * 这一帧画到画布上会是什么样,写成一串数:位置、大小按画布像素,透明度、颜色按 0–255 的色阶。
 * runtime 拿两帧的这串数比差多少(lookDiff),决定这一张画不画、什么时候画。
 * 取的都是 drawAvatar 真用到的量,换算也走它同一套取景(viewFor)与摆放(place):
 * 底色变暗与褪色、脸红、身体颜色;每层的可见度;每个部件的软网格外形、落地影;每只眼睛的位置、大小、眼皮、高光;
 * 画出来的特效(小头像不画特效,也就不算);戴着的每片装扮的外形与可见度。
 */
export function drawnLook(f: GuguFrame, o: DrawOpts, out: number[], outfit: OutfitDraw | null = null): number[] {
  out.length = 0
  const v = viewFor(o.w, o.h, o.crop, o.shape, f.ch, outfit)
  out.push(f.desat * 255, f.dim * 255, f.blush * 255)
  if (f.tint) out.push(f.tint[0] * 255, f.tint[1] * 255, f.tint[2] * 255)
  for (const L of f.layers) {
    const lay = f.alpha * L.alpha
    out.push(lay * 255)
    if (lay <= 0.004) continue
    const parts = L.parts
    for (let i = 0; i < parts.n; i++) {
      const p = parts.list[i]
      out.push(lay * p.alpha * 255)
      if (p.shOn) out.push(p.shx * v.s, p.shy * v.s, p.shrx * v.s * (1 - 0.28 * p.hopN), p.shry * v.s * (1 - 0.3 * p.hopN), p.hopN * 255)
      const spr = p.pack.spr
      for (const gy of LOOK_GRID)
        for (const gx of LOOK_GRID) {
          place(gx * spr.w, gy * spr.h, p, p.body, tmp)
          out.push(v.ox + tmp[0] * v.s, v.oy + tmp[1] * v.s)
        }
    }
    const ep = parts.list[L.eye.part]
    for (const e of L.eyes) {
      place(e.cx, e.cy, ep, ep.bodyE, tmp)
      // 眼睛的形状量都以它的半径为单位:乘上半径在画布上有多大,才是像素
      const k = e.r * ep.sc * v.s
      const sh = e.shape
      out.push(v.ox + tmp[0] * v.s, v.oy + tmp[1] * v.s, e.alpha * 255, k * sh.size, k * e.aspect, k * e.ax, k * e.ay, k * e.bx, k * e.by)
      out.push(k * sh.tOff, k * sh.tSlope, k * sh.tBow, k * sh.bOff, k * sh.bSlope, k * sh.bBow, k * e.gx * 0.1, k * e.gy * 0.1)
    }
    outfit?.drawnLook(f, L, v, o, out)
  }
  if (o.fx && Math.min(o.w, o.h) >= 70 * o.dpr) {
    for (const p of f.particles) {
      const age = f.time - p.born
      out.push(v.ox + (p.x + p.vx * age) * v.s, v.oy + (p.y + p.vy * age) * v.s, clamp(age / p.life) * 255)
    }
  }
  return out
}

/** 两帧画出来差多少:差得最多的那个数(像素 / 色阶);数的个数不一样(层、部件、特效多了少了)= Infinity */
export function lookDiff(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Infinity
  let d = 0
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]))
  return d
}
