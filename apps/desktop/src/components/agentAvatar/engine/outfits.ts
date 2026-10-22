/**
 * outfits.ts —— 配饰层:小鸟身上戴的装扮(形象的第三项,look.ts 的 wear)。一件装扮 = 一到几片抠好的素材,每片贴在一张
 * 和身体一样的软网格上,网格每个顶点都走引擎同一个 place()(= geometry.warp + 部件摆放),所以身体怎么挤、怎么歪、怎么蹦、
 * 怎么变形,它就怎么跟 —— 和眼睛、腮红是同一条路。配饰不改表情,也不改身体颜色。
 *
 * 挂法(mount):
 *  · head   挂在「长眼睛的那个部件」的头圆上(Pack.head 的圆心 + 半径为单位)。每个形态素材包都有自己的头圆,
 *           帽子换到球 /「!」/ 睡团上不用另配坐标;个别形态再用 forms 覆盖。
 *  · eyes   挂在两只眼睛此刻的位置上(含视线在球面上的滑动),眼镜跟着眼珠走。
 *  · ground 落在地上:带落地影的那些部件的脚下;身体蹦起来板子跟着「ollie」。
 *  · wing   握在右翅膀尖上:翅膀抬,伞跟着抬。
 *  · hold   刚体握在翅膀尖边上(魔杖、放大镜):跟着翅膀尖平移 + 转,不随网格扭。
 * 层次(pass):back 身体后面 / mid 身体上、眼睛下面 / top 眼睛上面(第二趟 GL)。
 * 二级运动(sway / bob / 滑板)只由身体动作驱动、会停下来:静止的小鸟画面不再变,runtime 就不重画(#7435)。
 */
import { rendererLogger } from '@/lib/log'
import { DEG, NEUTRAL_BODY, clamp, smoothstep, warp } from './geometry'
import { onWing, wingOf, type Rig } from './rig'
import { GRID_X, GRID_Y, type GuguGL } from './gl'
import type { GuguFrame, Layer } from './engine'
import type { FormId, Part } from './forms'
import type { Character } from './characters'
import { place, type Crop, type DrawOpts, type View } from './draw'
import { OUTFIT_BY_ID, wearKey, type Colorway, type Fit, type Mount, type OutfitDef, type Pass, type Piece, type WearItem } from './outfitCatalog'

const ASSETS = import.meta.glob('../assets/outfits/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

/** 一片素材打包后的地址;目录里写了、包里没有 = 构建坏了,当场报 */
function srcOf(pc: Piece): string {
  const url = ASSETS[`../assets/outfits/${pc.file}`]
  if (!url) throw new Error(`outfit asset missing from bundle: ${pc.file}`)
  return url
}

// ───────────── 二级运动:每只头像一份 ─────────────
class Osc {
  x = 0
  v = 0
  constructor(
    public w: number,
    public z: number
  ) {}
  step(dt: number, target: number, force = 0) {
    const a = -this.w * this.w * (this.x - target) - 2 * this.z * this.w * this.v + force
    this.v += a * dt
    this.x += this.v * dt
  }
}

/**
 * 由身体动作驱动的三个弹簧。没有常驻的「风」:身体不动,弹簧几拍之内就停,画面跟着停(runtime 据此不重画)。
 * 实验页那股一直在吹的微风去掉了 —— 它会让每只戴装扮的小鸟每帧都重画。
 */
export class OutfitRig {
  sway = new Osc(7.5, 0.16)
  bob = new Osc(16, 0.14)
  board = new Osc(30, 0.55)
  boardTilt = 0
  private prevH: number | null = null
  private prevHv = 0
  private prevHop: number | null = null
  private prevHopV = 0

  update(dt: number, f: GuguFrame) {
    dt = Math.min(dt, 1 / 20)
    if (dt <= 0) return
    const b = f.body
    // 头顶的横向位置(素材像素的近似):倾斜 + 平移 + 歪头 + 果冻波
    const h = b.lean + b.turn + b.roll * 6 + b.wob * Math.sin(5.5 - b.wobPhase)
    const hv = this.prevH === null ? 0 : (h - this.prevH) / dt
    const ha = (hv - this.prevHv) / dt
    this.prevH = h
    this.prevHv = hv
    const hopV = this.prevHop === null ? 0 : (b.hop - this.prevHop) / dt
    const hopA = (hopV - this.prevHopV) / dt
    this.prevHop = b.hop
    this.prevHopV = hopV
    this.sway.step(dt, 0, clamp(-ha * 0.0016, -40, 40) + clamp(hopA * 0.0004, -20, 20))
    this.sway.x = clamp(this.sway.x, -0.75, 0.75)
    this.bob.step(dt, 0, clamp(hopA * 0.6, -6000, 6000) + clamp((b.sy - 1) * -4000, -3000, 3000))
    this.bob.x = clamp(this.bob.x, -40, 40)
    this.board.step(dt, b.hop * 0.82)
    // 起跳板头上翘、下落放平;贴地时不歪
    this.boardTilt = clamp(-this.board.v * 0.00035, -0.2, 0.2) * smoothstep(2, 30, this.board.x)
  }
}

// ───────────── 素材:配色 = 同一张素材过一道 canvas filter;GL 纹理与 2D 定格用的图都按需取 ─────────────
const log = rendererLogger('agent-avatar/outfits')

const texId = (d: OutfitDef, pi: number, cw: number) => `outfit:${d.id}.${pi}#${cw}`

const urls = new Map<string, Promise<string>>()
/** 这一片在这个配色下的图(原色 = 打包的那张;别的配色在画布上过一道滤镜,得一张 blob 地址,整个会话只做一次) */
function pieceUrl(pc: Piece, cw: Colorway): Promise<string> {
  const src = srcOf(pc)
  if (cw.filter === 'none') return Promise.resolve(src)
  const key = `${src}#${cw.filter}`
  let p = urls.get(key)
  if (!p) {
    p = (async () => {
      const img = new Image()
      img.src = src
      await img.decode()
      const c = document.createElement('canvas')
      c.width = pc.size.w
      c.height = pc.size.h
      const x = c.getContext('2d')
      if (!x) throw new Error('2d context unavailable for outfit colorway')
      x.filter = cw.filter
      x.drawImage(img, 0, 0)
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
      if (!blob) throw new Error('outfit colorway encode failed')
      return URL.createObjectURL(blob)
    })()
    urls.set(key, p)
    p.catch(() => urls.delete(key))
  }
  return p
}

/** 每份 GL 上各片纹理的进度(载好的看 gl.has);载不下来的那片记一次错,以后不画也不等 */
const glState = new WeakMap<GuguGL, Map<string, 'loading' | 'failed'>>()
/** 2D 定格用的图(无 WebGL 时):键同纹理 id */
const flatImages = new Map<string, HTMLImageElement | 'loading' | 'failed'>()

export interface Worn {
  def: OutfitDef
  cw: number
}

// ───────────── 画 ─────────────
const tmp: [number, number] = [0, 0]
const corners = new Float32Array(8)

interface Rule {
  hide: boolean
  fit: Fit
  mount: Mount
}
/** 一片在一个形态里怎么挂(目录是静态的:每片每形态只算一次,❌ 每帧新建) */
const rules = new WeakMap<Piece, Partial<Record<FormId, Rule>>>()
function ruleFor(d: OutfitDef, pc: Piece, form: FormId): Rule {
  let byForm = rules.get(pc)
  if (!byForm) rules.set(pc, (byForm = {}))
  let rule = byForm[form]
  if (!rule) {
    const r = d.forms?.[form]
    rule = byForm[form] = {
      hide: !!r?.hide || (pc.only === 'forms' && form === 'body') || (pc.only === 'body' && form !== 'body'),
      fit: { ...(pc.fit ?? d.fit), ...(r?.fit ?? {}) },
      mount: pc.mount ?? d.mount
    }
  }
  return rule
}

/** 素材坐标里的二级运动:甩动区绕转轴转一点,绒球上下颤 */
function secondary(d: Piece, rig: OutfitRig, sx: number, sy: number, out: [number, number]) {
  let x = sx,
    y = sy
  const s = d.sway
  if (s && sy > s.y) {
    let g = smoothstep(0, s.ramp, sy - s.y)
    if (s.x0 !== undefined && s.x1 !== undefined) g *= smoothstep(s.x0 - 30, s.x0, sx) * (1 - smoothstep(s.x1, s.x1 + 30, sx))
    if (g > 0) {
      const a = rig.sway.x * s.k * g
      const c = Math.cos(a),
        si = Math.sin(a)
      const dx = x - s.x,
        dy = y - s.y
      x = s.x + dx * c - dy * si
      y = s.y + dx * si + dy * c
    }
  }
  const bb = d.bob
  if (bb) {
    const g = 1 - smoothstep(bb.r * 0.6, bb.r * 1.3, Math.hypot(sx - bb.x, sy - bb.y))
    if (g > 0) y += rig.bob.x * bb.k * g
  }
  out[0] = x
  out[1] = y
}

/** 部件素材坐标 → 世界:GL 走软网格变形(place);2D 定格走和本体那张图同一个整体挤压 / 跳起 */
type MapFn = (x: number, y: number, p: Part, out: [number, number]) => void
const meshMap: MapFn = (x, y, p, out) => place(x, y, p, p.body, out)
/** 骑在翅膀上的一点:先随翅膀的刚体动作转(rig.ts),再过身体(map);结果在 tmp */
function wingMap(map: MapFn, p: Part, rig: Rig, side: -1 | 1, x: number, y: number) {
  onWing(rig, side, p.body, x, y, tmp)
  map(tmp[0], tmp[1], p, tmp)
}
const flatMap: MapFn = (x, y, p, out) => {
  const P = p.pack
  out[0] = P.pivot.x + (x - P.pivot.x) * p.body.sx
  out[1] = P.pivot.y - p.body.hop + (y - P.pivot.y) * p.body.sy
}

export class OutfitDraw {
  readonly rig = new OutfitRig()
  private worn: Worn[] = []
  /** 这一身的写法(wearKey):换配色外形不变,runtime 靠它知道要重画 */
  key = ''
  /** 取景让给装扮的量(本体素材像素):各形态各算一份(那个形态收起的装扮不算),换形态时缓缓过去 */
  private extents = new Map<FormId, { head: number; hw: number }>()
  private head = 0
  private halfWidth = 0
  /** 刚换了一身:第一帧直接落到当前形态的取景上(❌ 一出场就缩放一下) */
  private snap = true
  /**
   * 这一身能不能跟着原地转圈(开心,rig.ts):装扮是正面画的贴图,转不过去。头上戴的、耳朵上的转起来看不出来;
   * 脸上(眼镜)、脖子、背上、身上、手里、脚下的会露馅 —— 穿着这些时 runtime 让引擎改成原地跳(engine.spinOK)
   */
  spins = true

  constructor(private ch: Character) {}

  /** 换一身(同一身不重算);认不出的 id 是调用方的错 —— look.ts 读地址时已经把认不出的筛掉了 */
  set(wear: readonly WearItem[] | undefined) {
    const key = wearKey(wear)
    if (key === this.key) return
    this.key = key
    this.worn = (wear ?? [])
      .map((w) => {
        const def = OUTFIT_BY_ID.get(w.id)
        if (!def) throw new Error(`unknown outfit id: ${w.id}`)
        return { def, cw: w.cw }
      })
      .sort((a, b) => a.def.z - b.def.z)
    this.spins = this.worn.every((w) => w.def.slot === 'head' || w.def.slot === 'ears')
    this.extents.clear()
    const e = this.extentsFor('body')
    this.head = e.head
    this.halfWidth = e.hw
    this.snap = true
  }

  /** 每帧:二级运动 + 取景跟到当前形态(小雨伞在睡团上收起了,就不再为它把整只缩小) */
  update(dt: number, f: GuguFrame) {
    this.rig.update(dt, f)
    if (!this.worn.length) return
    const e = this.extentsFor(f.layers[f.layers.length - 1].id)
    const k = this.snap ? 1 : 1 - Math.exp(-Math.max(0, dt) / 0.12)
    this.snap = false
    this.head += (e.head - this.head) * k
    this.halfWidth += (e.hw - this.halfWidth) * k
  }

  private extentsFor(form: FormId) {
    let e = this.extents.get(form)
    if (!e) this.extents.set(form, (e = { head: this.computeHead(form), hw: this.computeHalfWidth(form) }))
    return e
  }

  get wearing(): boolean {
    return this.worn.length > 0
  }

  /** 这一身在这份 GL 上还有几片在载(调用方等它们到位再画,❌ 先画光身再一闪穿上) */
  ensure(gl: GuguGL): number {
    let st = glState.get(gl)
    if (!st) glState.set(gl, (st = new Map()))
    const state = st
    let pending = 0
    for (const w of this.worn)
      w.def.pieces.forEach((pc, pi) => {
        const id = texId(w.def, pi, w.cw)
        if (gl.has(id)) return
        const s = state.get(id)
        if (s === 'failed') return
        pending++
        if (s === 'loading') return
        state.set(id, 'loading')
        void pieceUrl(pc, w.def.colorways[w.cw])
          .then((url) => gl.loadTexture(id, url, pc.size))
          .then(
            (ok) => (ok ? state.delete(id) : state.set(id, 'failed')),
            (err: unknown) => {
              log.error({ id, error: String(err) }, 'outfit piece load failed')
              state.set(id, 'failed')
            }
          )
      })
    return pending
  }

  /** 同上,无 WebGL 时 2D 定格用的图 */
  ensureFlat(): number {
    let pending = 0
    for (const w of this.worn)
      w.def.pieces.forEach((pc, pi) => {
        const id = texId(w.def, pi, w.cw)
        const s = flatImages.get(id)
        if (s === 'failed' || (s && s !== 'loading')) return
        pending++
        if (s === 'loading') return
        flatImages.set(id, 'loading')
        void pieceUrl(pc, w.def.colorways[w.cw])
          .then(async (url) => {
            const img = new Image()
            img.src = url
            await img.decode()
            flatImages.set(id, img)
          })
          .catch((err: unknown) => {
            log.error({ id, error: String(err) }, 'outfit piece load failed')
            flatImages.set(id, 'failed')
          })
      })
    return pending
  }

  /** 板子在素材像素里的缩放(以本体落地影为准,各形态共用:板子不随形态变大变小) */
  private boardK(d: OutfitDef) {
    return (2 * this.ch.shadow.rx * d.fit.w) / d.pieces[0].size.w
  }

  private board(): Worn | undefined {
    return this.worn.find((w) => w.def.mount === 'ground')
  }

  /** 取景:脚下多一块滑板,全身取景要再装下它多高(本体素材像素) */
  viewLift(crop: Crop): number {
    const b = this.board()
    if (!b || crop !== 'full') return 0
    const pc = b.def.pieces[0]
    return (pc.size.h - pc.anchor.y) * this.boardK(b.def) * 0.92
  }

  /** 取景:头上 / 手里的装扮比头顶高出多少(本体素材像素),不然被画布顶边切掉 */
  viewHead(): number {
    return this.head
  }

  /** 取景:手里的装扮伸出身体多远(本体素材像素,离 view.cx 的半宽) */
  viewHalfWidth(): number {
    return this.halfWidth
  }

  private computeHead(form: FormId) {
    const P = this.ch
    let top = P.view.top
    for (const w of this.worn) {
      const d = w.def
      for (const pc of d.pieces) {
        if (ruleFor(d, pc, form).hide) continue
        const fit = pc.fit ?? d.fit
        const m = pc.mount ?? d.mount
        if (m === 'head') {
          const sc = (fit.w * P.head.r) / pc.size.w
          top = Math.min(top, P.head.y + fit.tv * P.head.r - pc.anchor.y * sc)
        } else if (m === 'wing' && P.rig) {
          const sc = (fit.w * P.head.r) / pc.size.w
          top = Math.min(top, wingOf(P.rig, 1).grip.y + fit.tv - pc.anchor.y * sc * Math.cos((fit.rot ?? 0) * DEG))
        }
      }
    }
    return Math.max(0, P.view.top - top)
  }

  private computeHalfWidth(form: FormId) {
    const P = this.ch
    let hw = 0
    for (const w of this.worn)
      for (const pc of w.def.pieces) {
        if (ruleFor(w.def, pc, form).hide) continue
        const fit = pc.fit ?? w.def.fit
        const rig = P.rig
        if ((pc.mount ?? w.def.mount) !== 'wing' || !rig) continue
        const sc = (fit.w * P.head.r) / pc.size.w
        const r = (fit.rot ?? 0) * DEG
        const { at, grip } = wingOf(rig, 1)
        // 翅膀会转(刚体,rig.ts),伞握在翅尖上跟着转:几个翅膀位置都真算一遍,取最靠外的那一角
        for (const v of [-1, -0.5, 0, 0.6, 1.25, 1.9]) {
          const b = { ...NEUTRAL_BODY, wl: v, wr: v }
          onWing(rig, 1, b, at.x, at.y, tmp)
          warp(tmp[0], tmp[1], b, tmp, P)
          const r0x = tmp[0],
            r0y = tmp[1]
          onWing(rig, 1, b, grip.x, grip.y, tmp)
          warp(tmp[0], tmp[1], b, tmp, P)
          const a = r + Math.atan2(tmp[1] - r0y, tmp[0] - r0x) - Math.atan2(grip.y - at.y, grip.x - at.x)
          for (const [x, y] of [[0, 0], [pc.size.w, 0], [0, pc.size.h], [pc.size.w, pc.size.h]]) {
            const dx = (x - pc.anchor.x) * sc,
              dy = (y - pc.anchor.y) * sc
            hw = Math.max(hw, Math.abs(tmp[0] + fit.tu + dx * Math.cos(a) - dy * Math.sin(a) - P.view.cx) + 40)
          }
        }
      }
    return hw
  }

  /** 站在滑板上时部件自己的落地影淡一半(板子有自己的影) */
  shadowK(crop: Crop): number {
    return this.board() && crop === 'full' ? 0.5 : 1
  }

  has(L: Layer, pass: Pass): boolean {
    return this.worn.some((w) => w.def.pieces.some((pc) => pc.pass === pass && !ruleFor(w.def, pc, L.id).hide))
  }

  /** 落地的那几个部件(有落地影的)在世界里横跨多宽、地面在哪 */
  private ground(L: Layer) {
    let x0 = Infinity,
      x1 = -Infinity,
      y = -Infinity,
      a = 0
    for (let i = 0; i < L.parts.n; i++) {
      const p = L.parts.list[i]
      if (!p.shOn) continue
      x0 = Math.min(x0, p.shx - p.shrx)
      x1 = Math.max(x1, p.shx + p.shrx)
      y = Math.max(y, p.shy)
      a = Math.max(a, p.alpha)
    }
    if (!isFinite(x0)) return null
    return { cx: (x0 + x1) / 2, y, a }
  }

  /** 滑板自己的落地影 */
  shadow2d(ctx: CanvasRenderingContext2D, f: GuguFrame, L: Layer, v: View, o: DrawOpts) {
    const b = this.board()
    if (!b || o.crop !== 'full' || ruleFor(b.def, b.def.pieces[0], L.id).hide) return
    const g = this.ground(L)
    if (!g) return
    const pc = b.def.pieces[0]
    const k = this.boardK(b.def)
    const lift = this.viewLift(o.crop)
    const hopN = clamp(this.rig.board.x / 160)
    const rx = pc.size.w * k * 0.46 * (1 - 0.25 * hopN) * v.s
    const ry = rx * 0.09
    ctx.save()
    ctx.translate(v.ox + g.cx * v.s, v.oy + (g.y + lift - 4) * v.s)
    ctx.scale(1, ry / rx)
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
    const a = (o.bg ? 0.34 : 0.22) * (1 - 0.5 * hopN) * f.alpha * L.alpha * g.a
    const c = o.bg ? '24,86,66' : '40,40,44'
    gr.addColorStop(0, `rgba(${c},${a})`)
    gr.addColorStop(0.6, `rgba(${c},${a * 0.5})`)
    gr.addColorStop(1, `rgba(${c},0)`)
    ctx.fillStyle = gr
    ctx.beginPath()
    ctx.arc(0, 0, rx, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  /** 每片要画的(这一层、这一趟、这一形态不收起的),连同它的落位 */
  private each(L: Layer, o: DrawOpts, pass: Pass | null, fn: (w: Worn, pc: Piece, pi: number, mount: Mount, fit: Fit) => void) {
    const small = Math.min(o.w, o.h) < 70 * o.dpr
    for (const w of this.worn) {
      const d = w.def
      d.pieces.forEach((pc, pi) => {
        if (pass && pc.pass !== pass) return
        const r = ruleFor(d, pc, L.id)
        if (r.hide || (r.mount === 'ground' && o.crop !== 'full')) return // 半身取景看不到脚:滑板不画
        fn(w, pc, pi, r.mount, small && d.small ? { ...r.fit, w: r.fit.w * d.small } : r.fit)
      })
    }
  }

  /** GL:这一趟的各片画进共用画布 */
  mesh(gl: GuguGL, f: GuguFrame, L: Layer, v: View, o: DrawOpts, pass: Pass) {
    const lay = f.alpha * L.alpha
    this.each(L, o, pass, (w, pc, pi, mount, fit) => {
      const tex = texId(w.def, pi, w.cw)
      if (!gl.has(tex)) return // 载不下来的那片(ensure 已记过错)
      const verts = gl.verts
      let k = 0
      const alpha = this.piece(GRID_X, GRID_Y, pc, mount, fit, L, meshMap, (x, y) => {
        verts[k++] = v.ox + x * v.s
        verts[k++] = v.oy + y * v.s
      })
      if (alpha > 0) gl.drawSprite(tex, f.desat, f.dim, lay * alpha, null)
    })
  }

  /** 无 WebGL 的 2D 定格:每片按四角拼一个仿射整张贴上(不做网格变形,和本体那张图一样只跟整体挤压 / 跳起) */
  flat(ctx: CanvasRenderingContext2D, f: GuguFrame, L: Layer, v: View, o: DrawOpts, pass: Pass) {
    const lay = f.alpha * L.alpha
    this.each(L, o, pass, (w, pc, pi, mount, fit) => {
      const img = flatImages.get(texId(w.def, pi, w.cw))
      if (!img || typeof img === 'string') return
      let k = 0
      const alpha = this.piece(1, 1, pc, mount, fit, L, flatMap, (x, y) => {
        corners[k++] = v.ox + x * v.s
        corners[k++] = v.oy + y * v.s
      })
      if (alpha * lay < 0.004) return
      const [x0, y0, x1, y1, x2, y2] = corners
      ctx.save()
      ctx.globalAlpha = lay * alpha
      ctx.setTransform((x1 - x0) / pc.size.w, (y1 - y0) / pc.size.w, (x2 - x0) / pc.size.h, (y2 - y0) / pc.size.h, x0, y0)
      ctx.drawImage(img, 0, 0, pc.size.w, pc.size.h)
      ctx.restore()
    })
  }

  /** 画出来会是什么样(runtime 比两帧用,同 draw.ts drawnLook):每片的可见度 + 素材上 3×3 个点落在画布哪里 */
  drawnLook(f: GuguFrame, L: Layer, v: View, o: DrawOpts, out: number[]) {
    const lay = f.alpha * L.alpha
    this.each(L, o, null, (_w, pc, _pi, mount, fit) => {
      const at = out.length
      out.push(0)
      const alpha = this.piece(2, 2, pc, mount, fit, L, meshMap, (x, y) => out.push(v.ox + x * v.s, v.oy + y * v.s))
      out[at] = lay * alpha * 255
    })
  }

  /** 一片素材的 (nx+1)×(ny+1) 个网格顶点(世界坐标,逐个交给 put);返回这片的可见度(0 = 这一层画不了) */
  private piece(
    nx: number,
    ny: number,
    pc: Piece,
    mount: Mount,
    fit: Fit,
    L: Layer,
    map: MapFn,
    put: (x: number, y: number) => void
  ): number {
    const p = L.parts.list[L.eye.part]
    if (mount === 'head') {
      const P = p.pack
      const hr = P.head.r
      const sc = (fit.w * hr) / pc.size.w
      const rot = (fit.rot ?? 0) * DEG
      const c = Math.cos(rot),
        s = Math.sin(rot)
      const cx = P.head.x + fit.tu * hr,
        cy = P.head.y + fit.tv * hr
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          secondary(pc, this.rig, (i / nx) * pc.size.w, (j / ny) * pc.size.h, tmp)
          const dx = (tmp[0] - pc.anchor.x) * sc,
            dy = (tmp[1] - pc.anchor.y) * sc
          map(cx + dx * c - dy * s, cy + dx * s + dy * c, p, tmp)
          put(tmp[0], tmp[1])
        }
      return p.alpha
    }
    if (mount === 'eyes') {
      // 眼镜跟眼睛走同一个 place(bodyE):2D 定格里眼睛也是这样画的
      const [ea, eb] = L.eyes
      const e0 = ea.cx <= eb.cx ? ea : eb
      const e1 = e0 === ea ? eb : ea
      const lens = pc.lens!
      const span = lens[1].x - lens[0].x
      const xa = ((e1.cx - e0.cx) / span) * fit.w,
        xb = ((e1.cy - e0.cy) / span) * fit.w
      const ya = -xb,
        yb = xa
      const msx = (lens[0].x + lens[1].x) / 2,
        msy = (lens[0].y + lens[1].y) / 2
      const mx = (e0.cx + e1.cx) / 2 + ya * fit.tv * span,
        my = (e0.cy + e1.cy) / 2 + yb * fit.tv * span
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          const sx = (i / nx) * pc.size.w - msx,
            sy = (j / ny) * pc.size.h - msy
          place(mx + xa * sx + ya * sy, my + xb * sx + yb * sy, p, p.bodyE, tmp)
          put(tmp[0], tmp[1])
        }
      return p.alpha * clamp(L.eyeVis) * clamp(L.eye.vis) * clamp((e0.alpha + e1.alpha) / 2)
    }
    if (mount === 'ground') {
      const g = this.ground(L)
      if (!g) return 0
      const d = this.board()!.def
      const sc = this.boardK(d)
      const onBody = L.id === 'body' ? 1 : 0
      const gx = g.cx,
        gy = g.y - this.rig.board.x * onBody
      const rot = this.rig.boardTilt * onBody
      const c = Math.cos(rot),
        s = Math.sin(rot)
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          const dx = ((i / nx) * pc.size.w - pc.anchor.x) * sc,
            dy = ((j / ny) * pc.size.h - pc.anchor.y) * sc
          put(gx + dx * c - dy * s, gy + dx * s + dy * c)
        }
      return g.a
    }
    const rig = p.pack.rig
    if (!rig) return 0 // 变形后没有翅膀:手里的收起
    if (mount === 'hold') {
      // 握在翅膀尖边上:素材按本体坐标摆好(和 head 一样的落位),但整件是刚体 —— 只取握点随翅膀动过之后的位置和翅膀转过的角度,
      // 整件平移 + 旋转
      const sgn = pc.wing === 'r' ? 1 : -1
      const { at, grip } = wingOf(rig, sgn)
      const gx = grip.x,
        gy = grip.y
      wingMap(map, p, rig, sgn, at.x, at.y)
      const r0x = tmp[0],
        r0y = tmp[1]
      wingMap(map, p, rig, sgn, gx, gy)
      const t1x = tmp[0],
        t1y = tmp[1]
      const ang = Math.atan2(t1y - r0y, t1x - r0x) - Math.atan2(gy - at.y, gx - at.x)
      const c = Math.cos(ang),
        s = Math.sin(ang)
      const P = p.pack
      const hr = P.head.r
      const sc = (fit.w * hr) / pc.size.w
      const cx = P.head.x + fit.tu * hr,
        cy = P.head.y + fit.tv * hr
      for (let j = 0; j <= ny; j++)
        for (let i = 0; i <= nx; i++) {
          const dx = cx + ((i / nx) * pc.size.w - pc.anchor.x) * sc - gx,
            dy = cy + ((j / ny) * pc.size.h - pc.anchor.y) * sc - gy
          put(t1x + (dx * c - dy * s) * p.sc, t1y + (dx * s + dy * c) * p.sc)
        }
      return p.alpha
    }
    // wing:握在右翅膀尖上
    const { at, grip } = wingOf(rig, 1)
    wingMap(map, p, rig, 1, at.x, at.y)
    const rx0 = tmp[0],
      ry0 = tmp[1]
    wingMap(map, p, rig, 1, grip.x, grip.y)
    const ang = Math.atan2(tmp[1] - ry0, tmp[0] - rx0) - Math.atan2(grip.y - at.y, grip.x - at.x)
    const hx = tmp[0] + fit.tu * p.sc,
      hy = tmp[1] + fit.tv * p.sc
    const sc = (fit.w * p.pack.head.r) / pc.size.w
    const rot = (fit.rot ?? 0) * DEG + ang
    const c = Math.cos(rot),
      s = Math.sin(rot)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        secondary(pc, this.rig, (i / nx) * pc.size.w, (j / ny) * pc.size.h, tmp)
        const dx = (tmp[0] - pc.anchor.x) * sc,
          dy = (tmp[1] - pc.anchor.y) * sc
        put(hx + (dx * c - dy * s) * p.sc, hy + (dx * s + dy * c) * p.sc)
      }
    return p.alpha
  }
}
