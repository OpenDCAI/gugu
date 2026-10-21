/**
 * engine.ts —— 咕咕头像的"活"
 *
 * 和 Mochi 引擎一样，状态 = 一组连续参数；不同的是这里每个参数都挂在一根阻尼弹簧上：
 *   目标一变，弹簧自己带着过冲追过去；动画半路被打断，当前位置和速度原样接着走，永远不跳。
 * 三层叠加：
 *   ① 目标层：休息表情 / 展示状态 / 拍一拍的临时反应 → 各参数的目标值
 *   ② 弹簧层：把目标变成有重量的运动（挤压拉伸、歪头、眼皮）
 *   ③ 程序层：永不停止的微动——呼吸、眨眼、视线游走、重心摇晃，以及"性格化"的节律（蹦、抖、点头、扫视）
 *   ④ 形态层：展示状态让身体自己变形（缩成球/拉成「!」/分成三颗点/塌成一滩…），见 forms.ts；
 *      每个形态 = 设计稿出图抠下来的素材部件的摆放；眼睛长在各自的部件上；
 *      换形态的做法：
 *        · 旧形态先缩成一颗「种子」（约 0.1s），新形态从同一颗种子长出来（约 0.15s）——两张素材只在都缩成小团、重叠在同一点时交接，所以看不出是换图；
 *        · 整段只减速、不过冲（临界阻尼弹簧，指数缓出、从不过冲）；
 *        · 眼睛在缩的头 0.07s 闭上、整段闭着、新形态到位才睁开（官方：每次换形状都藏在一次眨眼里）；
 *        · 中途再换状态：弹簧接着当前位置和速度走，不跳。
 *      角色相关的一切数据（支点、眼睛球面、各形态素材、翅膀…）来自 characters.ts 的角色包，引擎本身与角色无关
 * 渲染是 frame 的纯函数，不在引擎里。
 */
import { BodyParams, TWO_PI, clamp, lerp, projectEye, smoothstep } from './geometry'
import { BUILDERS, BuildCtx, CropId, EyeSpec, FormId, Parts, formFor, stageFor } from './forms'
import { CHARACTER_BY_ID, Character, DEFAULT_CHARACTER } from './characters'
import type { Rgb } from './identity'
import {
  BLINK_CADENCE,
  DEFAULT_TEMPER,
  DisplayState,
  DisplayStateId,
  EXPRESSION_BY_ID,
  EXPRESSION_CADENCE,
  Expression,
  EyeShape,
  ExpressionId,
  FxKind,
  InternalExpressionId,
  STATE_BY_ID,
  Temper,
  expressionPool,
  nextPoolIndex
} from './spec'

// ───────────── 工具 ─────────────
class Spring {
  v = 0
  constructor(
    public x: number,
    public k: number,
    public z: number,
    public t = x
  ) {}
  step(dt: number) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / n
    const c = 2 * this.z * Math.sqrt(this.k)
    for (let i = 0; i < n; i++) {
      this.v += (this.k * (this.t - this.x) - c * this.v) * h
      this.x += this.v * h
    }
  }
}

/** 三层谐波叠加的"自然噪声"，周期互不成整数倍就看不出循环 */
function layered(t: number, period: number, phase = 0): number {
  const r = (t / period) * TWO_PI
  return (
    0.55 * Math.sin(r + phase) +
    0.3 * Math.sin(2 * r + phase * 1.7 + 1.1) +
    0.15 * Math.sin(3 * r + phase * 2.3 + 2.4)
  )
}

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type EyeKey = keyof EyeShape
const EYE_KEYS: EyeKey[] = ['size', 'tOff', 'tSlope', 'tBow', 'bOff', 'bSlope', 'bBow']

// ───────────── 输出 ─────────────
export interface EyeOut {
  cx: number
  cy: number // 眼心（素材像素，未变形）
  ax: number
  ay: number
  bx: number
  by: number // 局部 x/y 轴在素材平面上的像（含透视压扁）
  alpha: number // 转到头侧面时淡出
  r: number // 基础半径（素材像素）
  aspect: number // 眼睛高/宽（圆眼 1，竖椭圆 >1）
  inner: 1 | -1 // 鼻梁在这只眼的哪一侧（+1=右）
  shape: EyeShape // 解析后的形状（含眨眼）
  gx: number
  gy: number // 高光随视线的偏移 -1..1
}

export interface Particle {
  kind: FxKind
  born: number
  life: number
  x: number
  y: number // 素材像素（锚在头上）
  vx: number
  vy: number
  s: number
  rot: number
  glyph?: string
  w: 0 | 1 // 1 = 生在本体上，跟着本体软网格走；0 = 生在形态上，按世界坐标画
}

export interface GuguFrame {
  ch: Character
  time: number
  body: BodyParams // 本体态的整体变形（特效锚点用；各形态部件自带变形，见 layers）
  blush: number
  desat: number
  alpha: number
  dim: number
  hop: number
  particles: Particle[]
  state: DisplayState | null
  spin: number
  layers: Layer[] // 由下到上；最后一个 = 当前形态，前面的是正在淡出的旧形态
  /** 身份层的身体颜色:着色器里奶油身体逐通道乘的比值(identity.ts bodyTint);null = 素材原色 */
  tint: Rgb | null
}

/** 形态层：一个形态在场的那段时间。部件每帧由 forms.ts 的 builder 摆好，眼睛长在 eye.part 指的部件上 */
export interface Layer {
  id: FormId
  born: number
  leaveAt: number // <0 = 还在场
  variant: DisplayStateId | null // 进场时的展示状态（离场后继续按它演收尾）
  alpha: number // 整层可见度（只在缩成种子那一下交接：进场从种子长出时淡入、离场缩成种子时淡出）
  parts: Parts
  eye: EyeSpec
  eyes: [EyeOut, EyeOut]
  q: Spring // 到位程度：0 = 缩成种子，1 = 完整形态；离场时目标回 0
  live: boolean // 已放行开始长（要等上一层缩到种子附近，两团才在同一点交接）
  style: TransitionStyle // 这一层当前怎么变：缩成种子 / 压扁成一滩
  kSeed: number // 缩到种子时的缩放（让「自己」那一团正好是种子大小）
  cx: number
  cy: number // 「自己」那一团的中心（世界坐标，完整形态时）
  eyeVis: number // 眼睛可见度：缩成种子时眼睛跟着没了，长到八成大才回来（闭着）
}

/** 换形态的两种走法：pinch = 缩成种子再长出来（默认）；squash = 球压扁成一滩（出错：吓缩→塌） */
export type TransitionStyle = 'pinch' | 'squash'

interface Dir {
  expr: InternalExpressionId | null
  temper: Partial<Temper>
  desat: number
  alpha: number
  dim: number
  gazeAdd: [number, number]
  follow: number | null
  rollAdd: number
  turnAdd: number
  nodAdd: number
  blushAdd: number
}

/** 特效偏移量是按 A 的头半径（219.3）标定的；换角色按「自己那一团」的半径等比放大 */
const FX_REF_R = 219.3
const GRAVITY = 5200 // 素材像素/秒²；蹦 60px ≈ 0.3s 滞空，干脆利落

/** 变形中转的「种子」半径（可见圆半径的倍数），约为球半径的 1/3，按本体头的大小换算 */
const SEED_R = 0.17
/** 到位程度弹簧的刚度（临界阻尼，ω=√k）：长出来 ω≈28（约 0.15s 到位），缩回去 ω≈40（约 0.1s 缩成种子） */
const Q_IN = 800,
  Q_OUT = 1600
const GATE_PINCH = 0.3,
  GATE_SQUASH = 0.45 // 上一层缩到这个程度才放行新形态开始长

export class GuguEngine {
  readonly ch: Character
  private rng: () => number
  private time = 0
  private tState = 0
  private resting: ExpressionId = 'neutral'
  private state: DisplayStateId | null = null
  private react: { id: ExpressionId; until: number } | null = null
  private cur: InternalExpressionId | null = null
  // 表情池(spec.ts expressionPool):池下标 + 下次换的时刻(<0 = 进状态后第一帧再排)
  private rotIdx = 0
  private nextRot = -1
  private rotSwapped = false // 这一帧的表情变化是轮换换的:不重演表情的进场动作(蹦/抖/特效)
  /** 表情轮换开关。形象工坊里要一直看着选中的那张脸,关掉(只眨眼、只有小动作)。 */
  rotate = true
  /** 身体颜色正在过渡去的目标(setBodyColor 带过渡时);null = 不在过渡。 */
  private tintTo: Rgb | null = null

  // 弹簧
  private sy = new Spring(1, 150, 0.5)
  private sx = new Spring(1, 150, 0.55)
  private wl = new Spring(0, 130, 0.42) // 翅膀要有点过冲，扇起来才有「拍」的感觉
  private wr = new Spring(0, 130, 0.42)
  private lean = new Spring(0, 90, 0.45)
  private roll = new Spring(0, 110, 0.5)
  private turn = new Spring(0, 110, 0.6)
  private nod = new Spring(0, 110, 0.5)
  private puff = new Spring(0, 90, 0.6)
  private eyeL = Object.fromEntries(
    EYE_KEYS.map((k) => [k, new Spring(k === 'size' ? 1 : 0, 260, 0.62)])
  ) as Record<EyeKey, Spring>
  private eyeR = Object.fromEntries(
    EYE_KEYS.map((k) => [k, new Spring(k === 'size' ? 1 : 0, 260, 0.62)])
  ) as Record<EyeKey, Spring>
  private gYaw = new Spring(0, 420, 0.8)
  private gPitch = new Spring(0, 420, 0.8)
  private splitS = new Spring(1, 200, 0.7)
  private blushS = new Spring(0, 36, 1)
  private desatS = new Spring(0, 30, 1)
  private alphaS = new Spring(1, 110, 1) // 透明度要跟得快：从「淡影」回本体时，半透明的替身团子露面的时间越短越好，否则像个鬼影
  private dimS = new Spring(1, 30, 1)

  // 程序层状态
  private tp: Temper = { ...DEFAULT_TEMPER }
  private phB = 0
  private phH = 0
  private phQ = 0
  private hopY = 0
  private hopV = 0
  private wobAmp = 0
  private wobPhase = 0
  private shakeAmp = 0
  private blushBoost = 0
  private blinkStart = -10
  private blinkOpenAt = -10
  private nextBlink = 1.2
  private blinkHold = false // 变形期间眼睛闭着不睁，新形态到位才放开
  private blinkForced = false // 这次眨眼是变形带的（不受表情「不眨眼」的约束）
  private blinkC = 0 // 上一帧的闭眼程度（新的一次眨眼从这里接着闭）
  private nextSaccade = 0.8
  private sacYaw = 0
  private sacPitch = 0
  private fxNext: Partial<Record<FxKind, number>> = {}
  private nextWaitHop = 1.2
  private lastHopAt = -10
  private nextDoneHop = 3.2
  private t0: number
  private ready = false
  private particles: Particle[] = []

  /** 小尺寸放大动作幅度：44px 的头像上 3 像素的晃动看不见，所以越小越夸张（由挂载处按尺寸设） */
  gain = 1
  /** 取景：半身取景时团子形态整体上移缩小，免得出框（由挂载处设） */
  crop: 'full' | 'bust' = 'full'

  // 形态层
  private layers: Layer[] = []
  private seedX = new Spring(0, 900, 1) // 种子的位置：旧形态缩向它、新形态从它长出；换形态时它从旧的「自己」滑到新的「自己」（ω≈30，和长出来同步）
  private seedY = new Spring(0, 900, 1)
  private dotsS = new Spring(0, 40, 1) // 三颗点的跳动幅度（干活 1 → 后台 0 平滑过渡，不会在半空定住）
  private formNow: FormId = 'body'
  private burstDone = false
  private anchor: { x: number; y: number; r: number }
  private bodyE: BodyParams = {
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
    wr: 0
  }
  private bctx: BuildCtx
  private nextQuirk = 6
  private quirkRoll = 0
  private quirkUntil = 0

  readonly frame: GuguFrame

  constructor(seed = 1, chId: Character['id'] = DEFAULT_CHARACTER) {
    this.ch = CHARACTER_BY_ID[chId]
    const ch = this.ch
    this.anchor = { x: ch.head.x, y: ch.head.y, r: ch.head.r }
    this.rng = mulberry32(seed * 7919 + 13)
    this.t0 = this.rng() * 80
    this.layers = [this.makeLayer('body', -100, null, true)]
    this.bctx = {
      ch,
      st: stageFor(ch, 'full'),
      crop: 'full',
      age: 0,
      stateAge: 0,
      q: 1,
      base: undefined as unknown as BodyParams,
      baseE: this.bodyE,
      dots: 0,
      variant: null
    }
    this.frame = {
      ch,
      time: 0,
      body: {
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
        wr: 0
      },
      blush: 0,
      desat: 0,
      alpha: 1,
      dim: 1,
      hop: 0,
      particles: this.particles,
      state: null,
      spin: 0,
      layers: this.layers,
      tint: null
    }
    this.snapToTargets()
  }

  /** 新建一层：snap = 直接就是完整形态（第一帧）；否则缩在种子里等放行 */
  private makeLayer(
    id: FormId,
    born: number,
    variant: DisplayStateId | null,
    snap = false,
    style: TransitionStyle = 'pinch'
  ): Layer {
    const ch = this.ch
    const mkEye = (inner: 1 | -1): EyeOut => ({
      cx: 0,
      cy: 0,
      ax: 1,
      ay: 0,
      bx: 0,
      by: 1,
      alpha: 1,
      r: ch.eye.r,
      aspect: ch.eye.aspect,
      inner,
      shape: { size: 1, tOff: -1.3, tSlope: 0, tBow: 0, bOff: 1.3, bSlope: 0, bBow: 0 },
      gx: 0,
      gy: 0
    })
    return {
      id,
      born,
      leaveAt: -1,
      variant,
      alpha: snap ? 1 : 0,
      parts: new Parts(),
      eye: { part: 0, yaw: 0, pitch: 0, roll: 0, gazeY: 0, gazeP: 0, vis: 1 },
      eyes: [mkEye(1), mkEye(-1)],
      q: new Spring(snap ? 1 : 0, Q_IN, 1),
      live: snap,
      style,
      kSeed: 0.4,
      cx: 0,
      cy: 0,
      eyeVis: snap ? 1 : 0
    }
  }

  /** 换形态：旧层开始缩（或压扁），新层缩在种子里等放行；眼睛闭上、一直闭到新形态到位 */
  private startTransition(form: FormId, t: number) {
    const top = this.layers[this.layers.length - 1]
    const style: TransitionStyle =
      top.id === 'errorBall' && form === 'errorDome' ? 'squash' : 'pinch'
    top.leaveAt = t
    top.style = style
    this.layers.push(this.makeLayer(form, t, this.state, false, style))
    this.formNow = form
    while (this.layers.length > 3) this.layers.shift()
    this.blinkStart = t - this.blinkC * 0.07 // 正眨到一半就从一半接着闭，不回弹
    this.blinkHold = true
    this.blinkForced = true
  }

  // ───────────── 外部控制 ─────────────
  setExpression(id: ExpressionId) {
    this.resting = id
  }

  /**
   * 身份层的身体颜色(identity.ts bodyTint);null = 素材原色。
   * animate:从当前颜色过渡过去(约 0.2s,只减速不过冲);首次上色、或换成 / 换掉原色时直接落定。
   */
  setBodyColor(tint: Rgb | null, animate = false) {
    if (!animate || !tint || !this.frame.tint) {
      this.frame.tint = tint
      this.tintTo = null
      return
    }
    this.tintTo = tint
  }

  /** 此刻脸上的表情(测试与调试用) */
  get expression(): InternalExpressionId | null {
    return this.cur
  }

  setState(id: DisplayStateId | null) {
    if (id === this.state) return
    this.state = id
    this.tState = 0
    this.rotIdx = 0 // 进状态先演池里的第 0 个脸,过一个间隔再开始轮换
    this.nextRot = -1
    this.nextWaitHop = 0.9
    this.nextDoneHop = 3.2
    this.lastHopAt = -10
    this.burstDone = false
    this.particles.length = 0 // 换状态先清掉上一个状态留下的 z / 星星 / 汗滴
    if (!this.ready) return
    this.forceBlink()
  }

  /** 拍一拍：蹦一下 + 果冻波 + 眨眼 + 脸红 + 随机一个小反应 */
  poke() {
    this.hop(0.4)
    this.wobAmp = Math.max(this.wobAmp, 26)
    this.forceBlink()
    this.blushBoost = 0.75
    const pick: ExpressionId[] = ['surprised', 'happy', 'shy']
    this.react = { id: pick[Math.floor(this.rng() * pick.length)], until: this.time + 1.15 }
  }

  hop(power = 0.5) {
    if (this.hopY > 1) return
    this.hopV = 520 + 560 * power
    this.sy.v += 0.9 * power
    this.lastHopAt = this.time
  }

  private forceBlink() {
    if (this.blinkHold) return // 变形期间本来就闭着
    this.blinkStart = this.time - this.blinkC * 0.07
    this.blinkOpenAt = this.blinkStart + 0.07
  }

  private snapToTargets() {
    // 初始化时把弹簧直接放在休息表情上，避免第一帧从中性飞过去
    const ex = EXPRESSION_BY_ID[this.resting]
    this.applyExpressionTargets(ex, true)
  }

  // ───────────── 特效 ─────────────
  private spawn(kind: FxKind, glyph?: string) {
    if (this.particles.length > 28) this.particles.shift()
    const t = this.time
    const rnd = this.rng
    // 特效锚在「自己」那一团上（本体态=头），按它的大小缩放位置
    const A = this.anchor
    const q = A.r / FX_REF_R
    const HEADX = A.x,
      HEADY = A.y
    let p: Particle
    const w: 0 | 1 = this.formNow === 'body' ? 1 : 0
    switch (kind) {
      case 'z':
        p = {
          kind,
          born: t,
          life: 2.6,
          x: HEADX + 150 * q,
          y: HEADY - 90 * q,
          vx: 26 * q,
          vy: -48 * q,
          s: glyph === 'Z' ? 1.25 : 0.9,
          rot: 0.15,
          glyph: glyph ?? 'z',
          w
        }
        break
      case 'spark': {
        const ring = this.state === 'removed' // 已移除：星屑绕一整圈、停留久一点（设计稿 13）；其余只撒在头顶和两侧（上半圈）
        const a = ring ? rnd() * TWO_PI : -Math.PI + rnd() * Math.PI
        const rr = ring ? 200 + rnd() * 150 : 235 + rnd() * 80
        p = {
          kind,
          born: t,
          life: ring ? 1.4 + rnd() * 0.9 : 0.85 + rnd() * 0.5,
          x: HEADX + Math.cos(a) * rr * q,
          y: HEADY + Math.sin(a) * rr * q * 0.9 - 10 * q,
          vx: Math.cos(a) * 14 * q,
          vy: (Math.sin(a) * 14 - 10) * q,
          s: 0.7 + rnd() * 0.6,
          rot: rnd() * 1.2,
          w
        }
        break
      }
      case 'bang':
        p = {
          kind,
          born: t,
          life: 1.0,
          x: HEADX + 200 * q,
          y: HEADY - 165 * q,
          vx: 0,
          vy: -16,
          s: 1,
          rot: 0.12,
          glyph: '!',
          w
        }
        break
      case 'ques':
        p = {
          kind,
          born: t,
          life: 1.6,
          x: HEADX + 205 * q,
          y: HEADY - 165 * q,
          vx: 0,
          vy: -20,
          s: 1,
          rot: 0.18,
          glyph: '?',
          w
        }
        break
      case 'sweat':
        p = {
          kind,
          born: t,
          life: 1.2,
          x: HEADX + 188 * q,
          y: HEADY - 62 * q,
          vx: 4,
          vy: 70,
          s: 1,
          rot: 0,
          w
        }
        break
      default: // dots
        p = {
          kind,
          born: t,
          life: 1.9,
          x: HEADX + 215 * q,
          y: HEADY - 120 * q,
          vx: 0,
          vy: -6,
          s: 1,
          rot: 0,
          w
        }
    }
    this.particles.push(p)
  }

  private burst(n: number) {
    for (let i = 0; i < n; i++) this.spawn('spark')
  }

  private periodicFx(kind: FxKind, every: number) {
    const due = this.fxNext[kind] ?? 0
    if (this.time >= due) {
      this.fxNext[kind] = this.time + every * (0.85 + this.rng() * 0.3)
      if (kind === 'z') this.spawn('z', this.rng() < 0.5 ? 'z' : 'Z')
      else if (kind === 'spark') this.burst(2)
      else this.spawn(kind)
    }
  }

  // ───────────── 导演：展示状态 → 这一刻该演什么 ─────────────
  private direct(): Dir {
    const e = this.tState
    const t = this.time
    const d: Dir = {
      expr: null,
      temper: {},
      desat: 0,
      alpha: 1,
      dim: 1,
      gazeAdd: [0, 0],
      follow: null,
      rollAdd: 0,
      turnAdd: 0,
      nodAdd: 0,
      blushAdd: 0
    }
    switch (this.state) {
      case 'running': // 干活：身体变成三颗点（forms.ts），中间那颗长着眼睛，盯着正在跳的那颗
        d.expr = 'attentive'
        d.temper = { blink: 0.45 }
        d.follow = 0.1
        break
      case 'parked': // 后台：同样三颗点，不跳了，眼皮半垂
        d.expr = 'attentive'
        d.temper = { blink: 0.3 }
        d.follow = 0.05
        break
      case 'needsApproval':
      case 'needsAnswer':
      case 'needsPlanReview':
      case 'needsAction': // 等你：身体变成「!」，眼睛长在「!」上面看着你
        d.expr =
          this.state === 'needsAction'
            ? 'surprised'
            : this.state === 'needsPlanReview'
              ? 'attentive'
              : 'curious'
        d.follow = 0
        break
      case 'error': // 出错：先缩成一团吓一跳，再塌成一滩（0.85s 时塌，见 formFor）
        d.expr = e < 0.95 ? 'scared' : 'woe'
        d.desat = 0.12
        d.follow = 0.1
        break
      case 'done': // 做完了：变回本体、站稳了（0.28s）再蹦一下撒星星，之后每 3.4s 再蹦一次
        d.expr = 'happy'
        d.blushAdd = 0.1
        if (!this.burstDone) {
          if (e >= 0.28) {
            this.burstDone = true
            this.hop(1)
            this.burst(5)
            this.nextDoneHop = e + 3.4
          }
        } else if (e >= this.nextDoneHop) {
          this.hop(0.75)
          this.burst(3)
          this.nextDoneHop = e + 3.4
        }
        break
      case 'offline':
        d.expr = 'asleep'
        d.desat = 0.2
        d.dim = 1
        d.alpha = 1 // 暖暖地睡着，不是灰掉
        break
      case 'removed': // 缩成小点，散掉，只留一个淡淡的影子
        d.expr = 'asleep'
        if (e >= 0.55 && !this.burstDone) {
          this.burstDone = true
          this.burst(9)
        }
        d.desat = e < 0.55 ? 0.2 : 0.08
        d.dim = 1 // 半透明由「已移除」形态的部件自己带（别再叠一层，会发虚）
        if (e >= 0.7 && e < 8) this.periodicFx('spark', 0.14) // 设计稿 13：周围一圈暖金色星屑慢慢往外飘
        break
      case 'pending':
        d.expr = 'neutral'
        d.desat = 0.08
        d.follow = 0.1
        d.temper = { blink: 0.8 }
        break
      case 'none':
        d.desat = 0.22
        d.gazeAdd = [-14, -8]
        d.follow = 0 // 设计稿 15：淡淡站着，眼睛朝左上方出神，不跟光标
        break
      default: {
        // idle / online / null：不改写，休息表情说了算；偶尔来一点小动作，显得活着
        if (t >= this.nextQuirk) {
          const r = this.rng()
          if (r < 0.4) {
            this.quirkRoll = (this.rng() < 0.5 ? -1 : 1) * (4 + this.rng() * 3)
            this.quirkUntil = t + 1.4
          } else if (r < 0.7) this.hop(0.18)
          else this.sy.v += 0.55 // 伸个小懒腰
          // 不再顺带强制眨一下:眨眼有自己的节律(BLINK_CADENCE),小动作不该把它拉密
          this.nextQuirk = t + 6 + this.rng() * 7
        }
        if (t < this.quirkUntil)
          d.rollAdd = this.quirkRoll * Math.sin(Math.PI * (1 - (this.quirkUntil - t) / 1.4))
        break
      }
    }
    // 表情池:本位脸 + 短暂走神,引擎自己定时换,与交互无关(只换眼睛;进场动作不重演)
    const cad = this.rotate ? EXPRESSION_CADENCE[this.state ?? 'idle'] : undefined
    const pool = cad ? expressionPool(this.state, this.resting) : null
    if (cad && pool) {
      const hold = (home: boolean) => {
        const [lo, hi] = home ? cad.home : cad.away
        return lo + this.rng() * (hi - lo)
      }
      if (this.nextRot < 0) this.nextRot = t + hold(this.rotIdx === 0)
      else if (t >= this.nextRot) {
        this.rotIdx = nextPoolIndex(pool.length, this.rotIdx, this.rng())
        this.nextRot = t + hold(this.rotIdx === 0)
        this.rotSwapped = true
      }
      d.expr = pool[this.rotIdx % pool.length]
    }
    return d
  }

  // ───────────── 目标 ─────────────
  private applyExpressionTargets(ex: Expression, instant: boolean, d?: Dir) {
    const p = ex.posture
    this.sy.t = p.sy
    this.sx.t = p.sx
    this.puff.t = p.puff
    for (const k of EYE_KEYS) {
      this.eyeL[k].t = ex.L[k]
      this.eyeR[k].t = ex.R[k]
    }
    this.splitS.t = ex.split
    if (instant) {
      for (const k of EYE_KEYS) {
        this.eyeL[k].x = ex.L[k]
        this.eyeR[k].x = ex.R[k]
      }
      this.sy.x = p.sy
      this.sx.x = p.sx
      this.splitS.x = ex.split
      this.lean.x = p.lean
      this.roll.x = p.roll
      this.nod.x = p.nod
      this.turn.x = p.turn
      this.puff.x = p.puff
      this.gYaw.x = ex.gaze[0]
      this.gPitch.x = ex.gaze[1]
      this.blushS.x = ex.blush
    }
    void d
  }

  private onEnterExpression(ex: Expression) {
    const en = ex.enter
    if (!en) return
    if (en.hop) this.hop(en.hop)
    if (en.shake) this.shakeAmp = Math.max(this.shakeAmp, en.shake)
    if (en.squash) this.sy.v -= en.squash * 1.1
    if (en.fx && this.formNow === 'body') this.spawn(en.fx)
  }

  // ───────────── 每帧 ─────────────
  update(dtRaw: number, look: { x: number; y: number } | null) {
    const dt = clamp(dtRaw, 0, 0.05)
    this.time += dt
    this.tState += dt
    const t = this.time
    const tn = t + this.t0

    // 身体颜色过渡:逐通道指数逼近(时间常数 0.06s ≈ 0.2s 落定),只减速不过冲
    const from = this.frame.tint
    const to = this.tintTo
    if (to && from) {
      const k = 1 - Math.exp(-dt / 0.06)
      const next: Rgb = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k]
      const done = Math.max(Math.abs(to[0] - next[0]), Math.abs(to[1] - next[1]), Math.abs(to[2] - next[2])) < 0.002
      this.frame.tint = done ? to : next
      if (done) this.tintTo = null
    }

    if (this.react && t > this.react.until) this.react = null
    const d = this.direct()
    const first = !this.ready // 第一帧直接落到目标上，不从中性飞过去
    const form: FormId = this.ch.forms ? formFor(this.state, this.tState) : 'body'
    if (first) {
      this.layers.length = 0
      this.layers.push(this.makeLayer(form, -100, this.state, true))
      this.formNow = form
    } else if (form !== this.formNow) {
      this.startTransition(form, t)
    }
    const effId: InternalExpressionId = this.react?.id ?? d.expr ?? this.resting
    const ex = EXPRESSION_BY_ID[effId]
    if (effId !== this.cur) {
      this.cur = effId
      if (this.ready && !this.rotSwapped) this.onEnterExpression(ex)
    }
    this.rotSwapped = false
    this.ready = true
    this.applyExpressionTargets(ex, first, d)
    // 持续特效（犯困/睡着的 z、兴奋的星星）：形态到位了才开始飘；已移除只留星屑，不飘 z（设计稿 13）
    if (ex.fx && this.state !== 'removed' && this.layers[this.layers.length - 1].q.x > 0.9)
      this.periodicFx(ex.fx.kind, ex.fx.every)

    // 性格化节律：平滑过渡，状态一换不会突然炸开
    const tgt: Temper = { ...DEFAULT_TEMPER, ...ex.temper, ...d.temper }
    const kT = 1 - Math.exp(-dt / 0.22)
    for (const k of Object.keys(tgt) as (keyof Temper)[]) this.tp[k] += (tgt[k] - this.tp[k]) * kT
    const tp = this.tp

    // ───── 形态层目标 ─────
    this.dotsS.t = this.state === 'running' ? 1 : 0
    if (first) this.dotsS.x = this.dotsS.t
    const curEye = this.layers[this.layers.length - 1].eye // 上一帧该形态自带的视线偏置
    const fgY = curEye.gazeY
    const fgP = curEye.gazeP

    // 光标
    const follow = d.follow ?? ex.follow
    const fw = look ? follow : 0
    const lx = look ? look.x : 0
    const ly = look ? look.y : 0

    // 视线：游走 + 扫视 + 偶发的小跳视
    if (t >= this.nextSaccade) {
      this.sacYaw = (this.rng() - 0.5) * 9
      this.sacPitch = (this.rng() - 0.5) * 5
      this.nextSaccade = t + 0.8 + this.rng() * 2.2
    }
    const dYaw = layered(tn, 11.3, 0.4) * 5 + layered(tn, 3.7, 2.1) * 1.4
    const dPitch = layered(tn, 9.1, 1.3) * 3.6 + layered(tn, 4.3, 0.7) * 1.1
    const dRoll = layered(tn, 13.7, 3.2) * 2
    let scanOsc = 0
    if (tp.scan > 0.05) {
      const s = (t * tp.scanHz) % 1
      scanOsc = tp.scan * (s < 0.86 ? (s / 0.86) * 2 - 1 : lerp(1, -1, (s - 0.86) / 0.14))
    }
    const wander = 1 - clamp(fw * 0.8)
    const LG = this.ch.lookGain
    this.gYaw.t =
      ex.gaze[0] + d.gazeAdd[0] + fgY + lx * 26 * fw * LG + (dYaw + this.sacYaw) * wander + scanOsc
    this.gPitch.t =
      ex.gaze[1] + d.gazeAdd[1] + fgP + ly * 16 * fw * LG + (dPitch + this.sacPitch) * wander

    // 身体：节律叠加
    this.phB += dt * tp.breathHz * TWO_PI
    this.phH += dt * tp.bounceHz * Math.PI
    this.phQ += dt * tp.squishHz * TWO_PI
    const breath = Math.sin(this.phB) * tp.breath
    const arc = Math.abs(Math.sin(this.phH))
    const bq = clamp(tp.bounce / 20)
    const bounceY = tp.bounce * arc
    const bounceSy = 1 + bq * (0.035 * arc - 0.055 * Math.pow(1 - arc, 6))
    const squishS = Math.sin(this.phQ) * tp.squish
    const sway =
      tp.sway *
      (0.7 * Math.sin(TWO_PI * tp.swayHz * tn) +
        0.3 * Math.sin(TWO_PI * tp.swayHz * 1.73 * tn + 1.3))
    const tremor =
      tp.tremor * (0.6 * Math.sin(TWO_PI * 27 * t) + 0.4 * Math.sin(TWO_PI * 41 * t + 2))
    const nodOsc = tp.nod * Math.sin(TWO_PI * tp.nodHz * t)
    this.shakeAmp *= Math.exp(-dt * 4.2)
    const shake = this.shakeAmp * 15 * Math.sin(TWO_PI * 9 * t)

    const p = ex.posture
    this.lean.t = p.lean + lx * 12 * fw
    this.roll.t = p.roll + d.rollAdd + lx * 2 * fw
    this.turn.t = p.turn + d.turnAdd + lx * 16 * fw
    this.nod.t = p.nod + d.nodAdd + ly * 7 * fw
    // 翅膀：姿态位置 + 周期扇动（右翅略晚半拍，不是机械同步）
    const flapPh = TWO_PI * tp.flapHz * t
    this.wl.t = p.wl + tp.flap * Math.sin(flapPh) + breath * 4
    this.wr.t = p.wr + tp.flap * Math.sin(flapPh - 0.5) + breath * 4
    if (first) {
      this.wl.x = this.wl.t
      this.wr.x = this.wr.t
    }

    // 蹦的物理：真抛物线 + 落地时把冲量踢进挤压弹簧
    if (this.hopY > 0 || this.hopV > 0) {
      this.hopV -= GRAVITY * dt
      this.hopY += this.hopV * dt
      if (this.hopY <= 0 && this.hopV < 0) {
        const imp = -this.hopV
        this.hopY = 0
        this.hopV = 0
        this.sy.v -= imp * 0.0011
        this.wobAmp = Math.min(34, this.wobAmp + imp * 0.008)
      }
    }
    this.wobAmp *= Math.exp(-dt * 3.4)
    this.wobPhase += dt * 13

    // 眨眼：平时自己眨（0.07s 合、0.13s 睁）；变形期间闭上就不睁，等新形态到位（见形态层末尾）才睁开——官方的做法：每次换形状都藏在一次眨眼里
    let blinkC = 0
    if (!this.blinkHold && t >= this.nextBlink) {
      const bc = BLINK_CADENCE[this.state ?? 'idle']
      if (bc === null) {
        // 这个状态不眨眼(身体变成「!」/ 后台三颗点):不排眨眼,隔一秒看一眼状态换没换
        this.nextBlink = t + 1
      } else {
        this.blinkStart = t
        this.blinkOpenAt = t + 0.07
        const rate = Math.max(tp.blink, 0.05)
        let gap = bc ? bc[0] + this.rng() * (bc[1] - bc[0]) : (2 + this.rng() * 3.4) / rate
        if (this.rng() < 0.17) gap = 0.26
        this.nextBlink = t + gap
      }
    }
    const bt = t - this.blinkStart
    if (bt >= 0) {
      if (bt < 0.07) blinkC = bt / 0.07
      else if (this.blinkHold) blinkC = 1
      else {
        const ot = t - this.blinkOpenAt
        blinkC = ot < 0.13 ? (1 - ot / 0.13) ** 2 : 0
      } // 睁开：先快后慢
    }
    if (this.blinkForced && !this.blinkHold && t >= this.blinkOpenAt + 0.13)
      this.blinkForced = false
    if (!this.blinkForced) blinkC *= clamp(tp.blink / 0.3) // 平时的眨眼受表情节律约束（开心=不眨）；变形那一次不受
    this.blinkC = blinkC

    // 脸红 / 去色 / 透明
    this.blushBoost *= Math.exp(-dt * 0.65)
    this.blushS.t = clamp(ex.blush + d.blushAdd + this.blushBoost)
    this.desatS.t = d.desat
    this.alphaS.t = d.alpha
    this.dimS.t = d.dim

    // 持续特效（睡/兴奋等由表情带，状态带的在 direct 里）
    // 弹簧前进
    for (const s of [
      this.sy,
      this.sx,
      this.wl,
      this.wr,
      this.lean,
      this.roll,
      this.turn,
      this.nod,
      this.puff,
      this.gYaw,
      this.gPitch,
      this.splitS,
      this.blushS,
      this.desatS,
      this.alphaS,
      this.dimS
    ])
      s.step(dt)
    for (const k of EYE_KEYS) {
      this.eyeL[k].step(dt)
      this.eyeR[k].step(dt)
    }
    this.dotsS.step(dt)

    // ───── 合成输出 ─────
    const f = this.frame
    f.time = t
    const syT = clamp(this.sy.x * (1 + breath) * bounceSy * (1 + squishS), 0.6, 1.4)
    const sxT = clamp(this.sx.x * Math.pow(syT, -0.55) * (1 - squishS * 0.6), 0.7, 1.3)
    const b = f.body
    b.sy = syT
    b.sx = sxT
    const G = this.gain
    b.lean = (this.lean.x + sway + tremor + shake) * G
    b.roll = this.roll.x * (0.6 + 0.4 * G)
    b.turn = this.turn.x * G
    b.nod = (this.nod.x + nodOsc) * G
    b.puff = this.puff.x + breath * 0.9
    b.hop = (this.hopY + bounceY) * G
    b.wob = this.wobAmp * G
    b.wobPhase = this.wobPhase
    b.wl = clamp(this.wl.x, -1, 1.25)
    b.wr = clamp(this.wr.x, -1, 1.25)
    f.hop = b.hop
    f.blush = this.blushS.x
    f.desat = clamp(this.desatS.x)
    f.alpha = clamp(this.alphaS.x)
    f.dim = this.dimS.x
    f.state = this.state ? STATE_BY_ID[this.state] : null
    f.spin = f.state?.animate ? (t * TWO_PI) / 0.85 : 0

    // ───── 形态层输出 ─────
    // 脸区随视线滑：小嘴钉在球面正前方，眼睛转到哪它就跟到哪（只对带「脸区」的本体素材有效；形态素材的小嘴是画死的）
    const gx = clamp(this.gYaw.x * 0.05, -1, 1)
    const gy = clamp(this.gPitch.x * 0.05, -1, 1)
    if (this.ch.face) {
      const e0 = this.ch.eye
      const p0 = projectEye(e0.yaw0, e0.pitch0, e0.roll0, 0)
      const pn = projectEye(
        e0.yaw0 + this.gYaw.x,
        e0.pitch0 + this.gPitch.x,
        e0.roll0 + dRoll * 0.5,
        0
      )
      b.fx = (pn.x - p0.x) * e0.rs
      b.fy = (pn.y - p0.y) * e0.rs
    }
    Object.assign(this.bodyE, b)
    this.bodyE.fx = 0
    this.bodyE.fy = 0
    const bc = this.bctx
    bc.st = stageFor(this.ch, this.crop)
    bc.crop = this.crop as CropId
    bc.base = b
    bc.dots = clamp(this.dotsS.x)
    const eyes: [Record<EyeKey, Spring>, Record<EyeKey, Spring>] = [this.eyeL, this.eyeR]
    const nL = this.layers.length
    for (let li = nL - 1; li >= 0; li--) {
      const L = this.layers[li]
      const age = t - L.born
      const leaving = L.leaveAt >= 0
      // 到位程度：新层要等下面那层缩到种子附近才放行（0.12s 兜底），然后长向 1；离场层目标回 0（更硬的弹簧：缩比长快）
      if (leaving) {
        L.q.t = 0
        L.q.k = Q_OUT
      } else if (!L.live) {
        const below = li > 0 ? this.layers[li - 1] : null
        const gate = L.style === 'squash' ? GATE_SQUASH : GATE_PINCH
        if (!below || below.leaveAt < 0 || below.q.x < gate || age > 0.12) {
          L.live = true
          L.q.t = 1
          L.q.k = Q_IN
        }
      }
      L.q.step(dt)
      const q = clamp(L.q.x)
      if (leaving && li < nL - 1 && (q < 0.03 || t - L.leaveAt > 0.6)) {
        this.layers.splice(li, 1)
        continue
      }
      bc.age = Math.max(0, age)
      bc.stateAge = this.tState
      bc.q = q
      bc.variant = leaving ? L.variant : this.state
      const spec = L.eye
      spec.part = 0
      spec.yaw = 0
      spec.pitch = 0
      spec.roll = 0
      spec.gazeY = 0
      spec.gazeP = 0
      spec.vis = 1
      L.parts.reset()
      BUILDERS[L.id](bc, L.parts, spec)
      const parts = L.parts
      // 「自己」那一团：builder 指定的种子部件（没指定 = 长眼睛的那个）的头心；种子大小按它换算
      const sp = parts.list[parts.seed >= 0 ? parts.seed : spec.part]
      const C = {
        x: sp.gx + sp.sc * (sp.pack.head.x - sp.pack.pivot.x),
        y: sp.gy + sp.sc * (sp.pack.head.y - sp.pack.pivot.y)
      }
      L.cx = C.x
      L.cy = C.y
      L.kSeed = clamp((SEED_R * bc.st.R) / (sp.pack.head.r * sp.sc), 0.1, 0.85)
      if (li === nL - 1) {
        this.seedX.t = C.x
        this.seedY.t = C.y
        if (first) {
          this.seedX.x = C.x
          this.seedY.x = C.y
        }
      }
      if (L.style === 'pinch') {
        // 缩成种子 / 从种子长出：整层绕「自己」的中心等比缩放到种子大小，同时整体挪到种子所在处（q=1 时恒等）
        const k = L.kSeed + (1 - L.kSeed) * q
        const w = 1 - q
        const tx = (this.seedX.x - C.x) * w,
          ty = (this.seedY.x - C.y) * w
        for (let pi = 0; pi < parts.n; pi++) {
          const p = parts.list[pi]
          p.gx = C.x + (p.gx - C.x) * k + tx
          p.gy = C.y + (p.gy - C.y) * k + ty
          p.sc *= k
          if (p.shOn) {
            // 落地影留在地上，跟着横移、缩小、变淡（身子缩成种子 = 离地）
            p.shx = C.x + (p.shx - C.x) * k + tx
            p.shrx *= k
            p.shry *= k
            p.hopN = Math.max(p.hopN, 0.9 * w)
          }
          if (L.id === 'body') {
            // 本体缩成种子时翅膀收拢、长回来时再张开（不是整只等比缩小，是蜷起来）
            p.body.wl = lerp(p.body.wl, -0.85, w)
            p.body.wr = lerp(p.body.wr, -0.85, w)
          }
        }
        L.alpha = smoothstep(0.06, 0.2, q) // 只在缩到种子附近那 2–3 帧交接，两团这时大小、位置都几乎一样
      } else {
        // 压扁成一滩：旧球往下压扁（离场），新的一滩从高一点落下来压实（进场）；两张轮廓这时很接近，交接看不出
        for (let pi = 0; pi < parts.n; pi++) {
          const p = parts.list[pi]
          const sy = leaving ? 0.42 + 0.58 * q : 1 + 0.5 * (1 - q)
          const sx = leaving ? 1 + 0.3 * (1 - q) : 1 - 0.18 * (1 - q)
          p.body.sy *= sy
          p.body.sx *= sx
          p.bodyE.sy *= sy
          p.bodyE.sx *= sx
          if (p.shOn) p.shrx *= sx
        }
        L.alpha = leaving ? smoothstep(0.15, 0.4, q) : smoothstep(0.05, 0.3, q)
      }
      // 眼睛：离场时闭上（0.07s）后才跟着身子一起没；进场时身子长到八成多才带着闭着的眼回来，到位再睁（官方：眼睛是最后回来的）
      L.eyeVis = (leaving ? smoothstep(0.1, 0.3, q) : smoothstep(0.6, 0.85, q)) * spec.vis
      // 球面眼睛：长在眼睛部件的头那一团上（本体态它就是头，与原图两颗眼位置一致）
      const part = parts.list[spec.part]
      const pk = part.pack
      const pe = pk.eye
      const yawEff = pe.yaw0 + spec.yaw + this.gYaw.x
      const pitchEff = pe.pitch0 + spec.pitch + this.gPitch.x
      const rollEff = pe.roll0 + spec.roll + dRoll * 0.5
      const split = pe.split * this.splitS.x
      for (let i = 0; i < 2; i++) {
        const o = L.eyes[i]
        const pr = projectEye(yawEff, pitchEff, rollEff, (i === 0 ? -1 : 1) * split)
        o.cx = pk.head.x + pr.x * pe.rs
        o.cy = pk.head.y + pr.y * pe.rs
        o.ax = pr.ax
        o.ay = pr.ay
        o.bx = pr.bx
        o.by = pr.by
        o.alpha = (pr.depth <= 0.02 ? 0 : clamp(pr.depth / 0.12)) * L.alpha * L.eyeVis
        o.r = pe.r
        o.aspect = pe.aspect
        o.gx = gx
        o.gy = gy
        const sp2 = eyes[i]
        const sh = o.shape
        sh.size = sp2.size.x
        const c = blinkC
        sh.tOff = lerp(sp2.tOff.x, 0.82, c)
        sh.tSlope = sp2.tSlope.x * (1 - c)
        sh.tBow = sp2.tBow.x * (1 - c)
        sh.bOff = sp2.bOff.x
        sh.bSlope = sp2.bSlope.x
        sh.bBow = sp2.bBow.x
      }
      if (li === nL - 1) {
        // 特效锚在「自己」那一团（眼睛部件的头）上，世界坐标
        this.anchor.x = part.gx + part.sc * (pk.head.x - pk.pivot.x)
        this.anchor.y = part.gy + part.sc * (pk.head.y - pk.pivot.y)
        this.anchor.r = pk.head.r * part.sc
      }
    }
    this.seedX.step(dt)
    this.seedY.step(dt)
    // 新形态到位、眼睛回来了 → 放开眨眼，眼睛在新形态上睁开（1s 兜底，免得某个形态永远不放）
    const topL = this.layers[this.layers.length - 1]
    if (this.blinkHold && (topL.eyeVis > 0.9 || t - topL.born > 1)) {
      this.blinkHold = false
      this.blinkOpenAt = Math.max(t, this.blinkStart + 0.07)
    }

    // 粒子寿命
    for (let i = this.particles.length - 1; i >= 0; i--) {
      if (t - this.particles[i].born > this.particles[i].life) this.particles.splice(i, 1)
    }
  }
}
