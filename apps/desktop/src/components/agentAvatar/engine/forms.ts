/**
 * forms.ts —— 展示状态 = 身体自己变成的样子（学 Grok Blob 的方法：状态不靠旁边挂零件，身体本身就是那个符号；
 * 眼睛始终长在同一团东西上，视线一直落在它身上，所以读起来是"一个东西在变"，不是"换了张图"）。
 *
 * 形态的画面全部来自第 7 轮设计稿出图抠下来的素材包（characters.ts 的 forms / packs.fjj.ts），不再用代码画：
 * 每个形态 = 若干个「部件」（一张素材贴在软网格上，落点 + 缩放 + 微旋转），其中一个部件上长着眼睛。
 * 状态只决定「哪个形态、部件怎么摆、怎么动」；眼睛、表情、翅膀扇动之外的一切画面都是设计稿本身。
 *
 * 版面一律以「可见圆」为单位：Stage.R = 可见区半径，cy = 圆心。同一份布局在全身/半身取景下按比例成立。
 */
import { BodyParams, TWO_PI, clamp, smoothstep } from './geometry'
import type { Character, Pack } from './characters'
import type { DisplayStateId } from './spec'

export type FormId = 'body' | 'dots' | 'bang' | 'errorBall' | 'errorDome' | 'sleep' | 'roll'
export type CropId = 'full' | 'bust'

/** 展示状态 → 身体变成什么（本体态 = 不变形，表情/动作照旧）；e = 进入该状态后的秒数 */
export function formFor(state: DisplayStateId | null, e: number): FormId {
  switch (state) {
    case 'running':
    case 'parked':
      return 'dots' // 干活 / 后台：三颗点（跳 / 不跳）
    case 'needsApproval':
    case 'needsAnswer':
    case 'needsPlanReview':
    case 'needsAction':
      return 'bang' // 等你：「!」（四种只差动作和眼神，见 buildBang 与 engine 的 direct）
    case 'error':
      return e < 0.85 ? 'errorBall' : 'errorDome' // 出错：先缩成一团吓一跳（变形 0.3s + 睁眼看你 0.5s），再塌成一滩
    case 'offline':
    case 'removed':
      return 'sleep' // 不在线：蜷成一颗睡团；已移除：同一颗睡团飘起来变小（同一层，所以从不在线转过去是连着的）
    case 'pending':
      return 'roll' // 确认中：一颗球左右滚着张望
    default:
      return 'body'
  }
}

/** 可见区：圆心 (cx, cy) 与半径 R，素材（本体）坐标。取景公式与 draw.ts 的 viewFor 一一对应 */
export interface Stage {
  cx: number
  cy: number
  R: number
}
export function stageFor(ch: Character, crop: CropId): Stage {
  const v = ch.view
  if (crop === 'bust') {
    const H = v.ref / v.bustFill // 可见高度
    return { cx: v.cx, cy: v.top - 0.07 * H + 0.5 * H, R: 0.5 * H }
  }
  const H = v.ref / 0.8
  return { cx: v.cx, cy: v.bottom + 0.075 * H - 0.5 * H, R: 0.5 * H }
}

// ───────────── 部件 ─────────────
/** 一个部件：一张素材（贴软网格）+ 摆放。落地点 pack.pivot 落在世界 (gx, gy)，缩放 sc，再绕落地点转 rot（弧度） */
export interface Part {
  pack: Pack
  gx: number
  gy: number
  sc: number
  rot: number
  body: BodyParams // 软网格变形（素材单位，绕 pack.pivot）
  bodyE: BodyParams // 眼睛 / 腮红用的变形（不含脸区滑动：那只是素材上一片纹理在滑，它的梯度会把眼睛剪歪）
  alpha: number
  shOn: boolean // 画不画落地影
  shx: number
  shy: number
  shrx: number
  shry: number // 影的中心与半径（世界像素）
  hopN: number // 离地程度 0..1（影随之变小变淡）
}

export function neutralBody(): BodyParams {
  return {
    sx: 1,
    sy: 1,
    lean: 0,
    roll: 0,
    turn: 0,
    nod: 0,
    puff: 0,
    hop: 0,
    wob: 0,
    wobPhase: 0,
    fx: 0,
    fy: 0,
    wl: 0,
    wr: 0,
    yaw: 0
  }
}
export function copyBody(d: BodyParams, s: BodyParams) {
  Object.assign(d, s)
}

/** 一个形态的部件池（每帧复用，不产生垃圾） */
export class Parts {
  list: Part[] = []
  n = 0
  seed = -1 // 换形态时缩成「种子」/ 从种子长出的那个部件（-1 = 长眼睛的那个）：「!」是底下的点，棒从点里长出来
  reset() {
    this.n = 0
    this.seed = -1
  }
  add(pack: Pack, gx: number, gy: number, sc: number): Part {
    let p = this.list[this.n]
    if (!p) {
      p = {
        pack,
        gx,
        gy,
        sc,
        rot: 0,
        body: neutralBody(),
        bodyE: neutralBody(),
        alpha: 1,
        shOn: false,
        shx: 0,
        shy: 0,
        shrx: 0,
        shry: 0,
        hopN: 0
      }
      this.list[this.n] = p
    }
    this.n++
    p.pack = pack
    p.gx = gx
    p.gy = gy
    p.sc = sc
    p.rot = 0
    p.alpha = 1
    p.shOn = false
    p.shx = 0
    p.shy = 0
    p.shrx = 0
    p.shry = 0
    p.hopN = 0
    Object.assign(p.body, NEUTRAL)
    Object.assign(p.bodyE, NEUTRAL)
    return p
  }
}
const NEUTRAL = neutralBody()

/** 眼睛长在哪个部件上，以及该形态自带的眼睛朝向偏置（度）；vis = 形态自己决定的眼睛可见度（「!」的棒没长高之前眼睛先不出来） */
export interface EyeSpec {
  part: number
  yaw: number
  pitch: number
  roll: number
  gazeY: number
  gazeP: number
  vis: number
}

export interface BuildCtx {
  ch: Character
  st: Stage
  crop: CropId
  age: number // 这个形态已存在多久（秒）
  stateAge: number // 当前展示状态已持续多久（秒）：同一形态内的状态变体（不在线→已移除）从它起算
  q: number // 到位程度 0..1：0 = 缩成种子（刚进场 / 快离场），1 = 完整形态。各部件的「长出来 / 收回去」按它走，进出对称
  base: BodyParams // 引擎这一帧的整体身体参数（呼吸 / 蹦 / 歪头 / 果冻波…）
  baseE: BodyParams // 同上，去掉脸区滑动
  dots: number // 三颗点的跳动幅度 0..1（干活 1，后台 0）
  variant: DisplayStateId | null
}

/** 影：贴在 (x, y)，宽 rx 高 ry（世界像素） */
function shadow(p: Part, x: number, y: number, rx: number, ry: number, hopN = 0) {
  p.shOn = true
  p.shx = x
  p.shy = y
  p.shrx = rx
  p.shry = ry
  p.hopN = clamp(hopN)
}
/** 压扁时横向跟着变宽（体积感） */
function squash(b: BodyParams, sy: number) {
  b.sy *= sy
  b.sx *= 1 + (1 - sy) * 0.6
}
const easeOut = (x: number) => 1 - (1 - clamp(x)) ** 3

type Builder = (c: BuildCtx, out: Parts, eye: EyeSpec) => void

// ───────────── 本体：不变形 ─────────────
const buildBody: Builder = (c, out, eye) => {
  const ch = c.ch
  const p = out.add(ch, ch.pivot.x, ch.pivot.y, 1)
  copyBody(p.body, c.base)
  copyBody(p.bodyE, c.baseE)
  if (c.crop === 'full')
    shadow(
      p,
      ch.shadow.x + 8,
      ch.pivot.y - 4,
      ch.shadow.rx * c.base.sx,
      ch.shadow.ry,
      c.base.hop / 110
    )
  eye.part = out.n - 1
}

// ───────────── 干活 / 后台：三颗点，一个接一个往上跳 ─────────────
const buildDots: Builder = (c, out, eye) => {
  const { st, ch, age } = c
  const F = ch.forms!
  const face = F.faceball,
    pl = F.plain
  const kp = 1.0,
    gap = 22 // 两侧素球相对带脸球的大小 / 间隙（素材像素）
  const wTot = face.spr.w + 2 * pl.spr.w * kp + 2 * gap
  const sc = ((c.crop === 'bust' ? 1.52 : 1.68) * st.R) / wTot // 半身小圆头像里收一点，两侧的点不顶着圆边
  const baseY = st.cy + 0.24 * st.R
  const dx = (face.spr.w / 2 + gap + (pl.spr.w * kp) / 2) * sc
  const H = 0.2 * st.R * c.dots * smoothstep(0.6, 0.98, c.q) // 三颗点站定了才开始跳（进场中不跳，离场时跳动收住）
  const lift = [0, 0, 0],
    sq = [1, 1, 1]
  for (let i = 0; i < 3; i++) {
    const ph = (((age * 1.25 - i * 0.18) % 1) + 1) % 1
    if (ph < 0.36) lift[i] = Math.sin((ph / 0.36) * Math.PI) * H
    else if (ph < 0.5) sq[i] = 1 - 0.09 * c.dots * Math.sin(((ph - 0.36) / 0.14) * Math.PI)
  }
  // 两侧的素球从中间那颗后面滑出来（官方：三点是从球后面分出来的）；收回去时反着滑回去。藏在后面时抬到带脸球的球心高度，不会从底下露出来
  const spread = smoothstep(0.3, 0.95, c.q)
  const hide =
    ((face.pivot.y - face.head.y) * sc - (pl.pivot.y - pl.head.y) * sc * kp) * (1 - spread)
  for (const i of [0, 2]) {
    const p = out.add(pl, st.cx + (i - 1) * dx * spread, baseY - lift[i] * spread - hide, sc * kp)
    p.body.sy = (1 + (c.base.sy - 1) * 0.5) * sq[i]
    p.body.sx = 1 + (1 - p.body.sy) * 0.6
    copyBody(p.bodyE, p.body)
    shadow(
      p,
      p.gx,
      baseY - 2 * sc,
      pl.shadow.rx * sc * kp * spread,
      pl.shadow.ry * sc * kp * spread,
      lift[i] / Math.max(1, H)
    )
  }
  const p = out.add(face, st.cx, baseY - lift[1], sc)
  copyBody(p.body, c.base)
  copyBody(p.bodyE, c.baseE)
  squash(p.body, sq[1])
  squash(p.bodyE, sq[1])
  shadow(
    p,
    p.gx,
    baseY - 2 * sc,
    face.shadow.rx * sc,
    face.shadow.ry * sc,
    lift[1] / Math.max(1, H)
  )
  eye.part = out.n - 1
  // 中间那颗（有眼睛）看向正在跳的那颗
  const look = lift[0] > lift[2] + 1 ? -1 : lift[2] > lift[0] + 1 ? 1 : 0
  eye.yaw = look * 16 * c.dots
  eye.pitch = -3 * c.dots
}

// ───────────── 等你：「!」 = 一根棒（只有脸，没有翅膀：owner 10-12「感叹号的时候把手去掉」）+ 一颗点；每 2.4 秒整体轻跳一下，点比棒晚半拍落地 ─────────────
const buildBang: Builder = (c, out, eye) => {
  const { st, ch, age } = c
  const F = ch.forms!
  const stem = F.stem
  const dot = F.plain
  const kd = 0.72 // 点相对素材的大小
  const dotW = dot.spr.w * kd
  const total = stem.spr.h + dotW * 0.9
  const sc = ((c.crop === 'bust' ? 1.5 : 1.58) * st.R) / total // 轻跳时棒顶也不出框（200px 卡片里 1.68 会顶到上边）；半身小圆头像再收一点
  const dotR = (dotW / 2) * sc
  const bottom = st.cy + 0.84 * st.R // 点的最低处
  const dotCy = bottom - dotR
  const stemBase = dotCy - dotR * 0.5 // 棒的底（收窄处）压在点的上缘
  const cyc = (age - 0.9 + 24) % 2.4 // 长出来站稳了（0.9s）才开始第一次轻跳
  const H = 0.12 * st.R
  const hop = (t: number) => (t > 0 && t < 0.46 ? Math.sin((t / 0.46) * Math.PI) * H : 0)
  let tilt = 4 * Math.sin(age * TWO_PI * 0.45)
  const v = c.variant
  if (v === 'needsAnswer') tilt = 9 * Math.sin(age * TWO_PI * 0.32) // 歪着问
  if (v === 'needsApproval') {
    // 跳完点两下头
    const k = cyc - 0.46
    if (k > 0 && k < 1.1) tilt += 7 * Math.sin(k * TWO_PI * 2.0) * Math.exp(-k * 2.2)
  }
  const hb = hop(cyc),
    hd = hop(cyc - 0.09)
  const pd = out.add(dot, st.cx, dotCy + dotR - hd, sc * kd)
  pd.body.sy = c.base.sy
  pd.body.sx = 1 / Math.sqrt(Math.max(0.5, c.base.sy))
  copyBody(pd.bodyE, pd.body)
  shadow(
    pd,
    pd.gx,
    bottom + 2 * sc,
    dot.shadow.rx * sc * kd * 1.1,
    dot.shadow.ry * sc * kd * 1.1,
    hd / H
  )
  out.seed = out.n - 1 // 种子是底下的点：球缩成点，棒再从点里往上长出来（官方的「!」就是这么长的）
  const g = smoothstep(0.3, 0.92, c.q)
  const grow = 0.05 + 0.95 * g,
    slim = 0.4 + 0.6 * g // 没长高时也窄一点，不然是压扁的一片
  const ps = out.add(stem, st.cx, stemBase - hb, sc)
  copyBody(ps.body, c.base)
  copyBody(ps.bodyE, c.baseE)
  ps.body.sy *= grow
  ps.bodyE.sy *= grow // 绕落点（棒底）纵向长高 = 从点里长出来
  ps.body.sx *= slim
  ps.bodyE.sx *= slim
  ps.rot = (tilt * Math.PI) / 180
  eye.part = out.n - 1
  eye.vis = g // 棒长高了眼睛才出来
  eye.pitch = -2
  if (v === 'needsPlanReview') {
    // 看计划：眼睛一行一行扫
    const u = age % 3.4
    if (u < 2.1) {
      eye.gazeY = -6 + u * 9
      eye.gazeP = 12
    }
  }
}

// ───────────── 出错：先被吓得缩一下（带脸的球），再塌成一滩（穹形） ─────────────
const buildErrorBall: Builder = (c, out, eye) => {
  const { st, ch, age } = c
  const pk = ch.forms!.faceball
  const sc = (0.98 * st.R) / pk.spr.w
  const baseY = st.cy + 0.6 * st.R
  const p = out.add(pk, st.cx, baseY, sc)
  copyBody(p.body, c.base)
  copyBody(p.bodyE, c.baseE)
  // 吓一跳：长出来之后（0.12s）先猛缩一下再弹回（离场往下压扁成一滩由引擎的 squash 走法接管）
  const a = Math.max(0, age - 0.12)
  const fright = Math.exp(-a * 9) * Math.cos(a * 26)
  p.body.sy *= 1 - 0.14 * fright
  p.body.sx *= 1 + 0.08 * fright
  p.body.lean += 5 * Math.sin(a * TWO_PI * 11) * Math.exp(-a * 3)
  copyBody(p.bodyE, p.body)
  shadow(p, st.cx, baseY - 2 * sc, pk.shadow.rx * sc, pk.shadow.ry * sc)
  eye.part = out.n - 1
}

const buildErrorDome: Builder = (c, out, eye) => {
  const { st, ch, age } = c
  const pk = ch.forms!.dome
  const sc = (1.36 * st.R) / pk.spr.w
  const baseY = st.cy + 0.6 * st.R
  const p = out.add(pk, st.cx, baseY, sc)
  copyBody(p.body, c.base)
  copyBody(p.bodyE, c.baseE)
  // 落下来压实那一下由引擎的 squash 走法带；之后慢慢起伏，偶尔抽一下（软塌塌的扁团）
  const sob = Math.max(0, Math.sin(age * TWO_PI * 0.55)) ** 6
  p.body.sy *= 1 + 0.035 * sob
  copyBody(p.bodyE, p.body)
  shadow(p, st.cx, baseY - 2 * sc, pk.shadow.rx * sc, pk.shadow.ry * sc)
  eye.part = out.n - 1
  eye.pitch = 2
}

// ───────────── 不在线：蜷成一颗睡团，坐在地上；已移除：同一颗睡团慢慢飘起来、变小、半透明，周围星屑往外飘 ─────────────
const buildSleep: Builder = (c, out, eye) => {
  const { st, ch } = c
  const pk = ch.forms!.sleep
  const gone = c.variant === 'removed' ? c.stateAge : -1
  const u = gone < 0 ? 0 : easeOut(gone / 1.3)
  const shrink = 1 - 0.24 * u
  const rise = 0.2 * st.R * u + (gone < 0 ? 0 : 0.012 * st.R * Math.sin(gone * TWO_PI * 0.3))
  const sc = ((1.1 * st.R) / pk.spr.w) * shrink
  const baseY = st.cy + 0.6 * st.R
  const p = out.add(pk, st.cx, baseY - rise, sc)
  copyBody(p.body, c.base)
  p.body.lean *= 0.5
  copyBody(p.bodyE, p.body)
  p.alpha = 1 - 0.12 * u
  const lifted = rise / (0.3 * st.R)
  shadow(
    p,
    st.cx,
    baseY - 2 * sc,
    pk.shadow.rx * sc * (1 - 0.3 * u),
    pk.shadow.ry * sc * (1 - 0.3 * u),
    lifted * 0.8
  )
  eye.part = out.n - 1
}

// ───────────── 确认中：一颗球微微歪着左右滚，眼睛朝滚的方向看 ─────────────
const buildRoll: Builder = (c, out, eye) => {
  const { st, ch, age } = c
  const pk = ch.forms!.roll
  const sc = (1.02 * st.R) / pk.spr.w
  const baseY = st.cy + 0.6 * st.R
  const ph = age * TWO_PI * 0.23
  const dir = Math.cos(ph)
  const x = st.cx + 0.2 * st.R * Math.sin(ph)
  const p = out.add(pk, x, baseY, sc)
  copyBody(p.body, c.base)
  copyBody(p.bodyE, c.baseE)
  p.rot = 0.1 * dir
  shadow(p, x, baseY - 2 * sc, pk.shadow.rx * sc, pk.shadow.ry * sc)
  eye.part = out.n - 1
  eye.gazeY = clamp(dir * 3, -1, 1) * 10
  eye.gazeP = -4
}

export const BUILDERS: Record<FormId, Builder> = {
  body: buildBody,
  dots: buildDots,
  bang: buildBang,
  errorBall: buildErrorBall,
  errorDome: buildErrorDome,
  sleep: buildSleep,
  roll: buildRoll
}
