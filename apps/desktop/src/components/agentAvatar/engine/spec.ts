/**
 * spec.ts —— 咕咕头像的两层空间：表情（静止姿态 + 进场动作的时间表）与展示状态。逐帧的运动由 engine.ts 演
 *
 *  · 16 种休息表情：用「眼睛形状 + 眉毛 + 腮红 + 身体姿态 + 性格化的小动作」表达，喙不张开（owner 10-22）；配饰是另一层（outfits.ts），不改表情
 *    有的表情带一个进场动作（act）：进入这个表情时演一次就停（mac 上持续出帧很贵，空闲时不该一直动）
 *  · 14 种展示状态：名字 / 颜色 / 动不动 一律抄咕咕仓里 `presentAgentStatus` 那张表
 *    （packages/core/src/shared/agentStatusPresentation.ts + styles/tokens.css 的 --agent-tone-*），❌ 自己另起
 *
 * 眼睛形状 = 一颗黑豆（椭圆）∩ 上眼睑曲线 ∩ 下眼睑曲线。曲线是抛物线：
 *   v(u') = off + slope·u'inner + bow·(1 − u'²)       u'∈[-1,1] 横跨眼睛，v'∈[-1,1] 竖跨眼睛（下为正）
 *   slope 以「靠近鼻梁那一侧为正」定义，两只眼自动镜像
 * 睁眼：上线在椭圆之外(-1.3)、下线在椭圆之外(+1.3)；眯眼/半闭：上线下移；笑眼：下线拱起；闭眼：两线并拢成一条弯月。
 * 另有三种闭着的画法（face.ts）：arc ≥ 0.5 = ^ 笑弧、flat = 1 → ‒ 平线、chev = 1 → > < 挤眼。
 */
import { smoothstep } from './geometry'

export type ExpressionId =
  | 'neutral'
  | 'attentive'
  | 'surprised'
  | 'excited'
  | 'happy'
  | 'laughing'
  | 'angry'
  | 'sad'
  | 'scared'
  | 'suspicious'
  | 'confused'
  | 'curious'
  | 'proud'
  | 'shy'
  | 'unimpressed'
  | 'sleepy'

/** 状态专用、不在 16 种之内的姿态（睡着/闭眼） */
export type InternalExpressionId = ExpressionId | 'asleep' | 'woe'

export interface EyeShape {
  size: number
  tOff: number
  tSlope: number
  tBow: number
  bOff: number
  bSlope: number
  bBow: number
  arc: number
  flat: number
  chev: number
}

/** 眉毛（face.ts drawBrow）：on 可见度；lift 高低（眼高为单位，+ 高）；tilt 鼻梁侧抬起为 +（愁）、压下为 -（凶）；arch 弯度 */
export interface BrowShape {
  on: number
  lift: number
  tilt: number
  arch: number
}

/** 腮红的位置和样子（深浅是 Expression.blush）：lift 被笑容顶上去；wide 横向大小；lines 三道短红晕线（大头像才画） */
export interface CheekShape {
  lift: number
  wide: number
  lines: number
}

/**
 * 进场动作：进入这个表情时演一次（kick 是那一下的冲量，交给引擎的物理；fx 是这一次里按时刻放的特效；at 写逐帧的偏移）。
 * every = 还停在这个表情时隔多久再演一次（不再给 kick）；轮换到这张脸不演进场，只从一个间隔之后开始重复。
 * at(t, o) 写这一刻相对静止姿态的偏移：身体各项和 wingAdd 是加上去的；wing / eye 以 wingK / eyeK 的权重盖过去（结束前交还给弹簧）。
 */
export interface ActFrame {
  hop: number
  sy: number
  sx: number
  lean: number
  roll: number
  nod: number
  puff: number
  pitch: number
  yaw: number
  wingAdd: number // 度
  wing: number // 度
  wingK: number
  eye: Partial<EyeShape>
  eyeK: number
  brow: number
  browR: number
  cheek: number
}
export interface Act {
  dur: number
  kick?: { hop?: number; shake?: number; squash?: number }
  fx?: { at: number; kind: FxKind }[]
  every?: number
  at?(t: number, o: ActFrame): void
}

export interface Posture {
  sy: number
  sx: number
  lean: number
  roll: number
  turn: number
  nod: number
  puff: number
  wl: number
  wr: number // 翅膀：-1 垂 … 0 收着 … +1 举（没翅膀的角色忽略）
}

/** 性格化的小动作：幅度全是"连续数"，状态切换时平滑过渡 */
export interface Temper {
  breath: number
  breathHz: number // 呼吸幅度（占高度比例）、频率
  bounce: number
  bounceHz: number // 节律性小跳：高度（素材像素）、频率
  tremor: number // 发抖：横向抖动（素材像素）
  sway: number
  swayHz: number // 左右摇摆（素材像素）
  nod: number
  nodHz: number // 点头（素材像素）
  squish: number
  squishHz: number // 抖动式压缩（大笑）
  blink: number // 眨眼频率倍率，0 = 不眨
  scan: number
  scanHz: number // 视线扫视幅度（度）、频率
  flap: number
  flapHz: number // 扇翅膀：幅度（-1..1 的翅膀位置）、频率（没翅膀的角色忽略）
}

export const DEFAULT_TEMPER: Temper = {
  breath: 0.011,
  breathHz: 0.42,
  bounce: 0,
  bounceHz: 2,
  tremor: 0,
  sway: 5,
  swayHz: 0.11,
  nod: 0,
  nodHz: 0.6,
  squish: 0,
  squishHz: 6,
  blink: 1,
  scan: 0,
  scanHz: 0.5,
  flap: 0,
  flapHz: 3
}

export type FxKind = 'z' | 'spark' | 'bang' | 'ques' | 'sweat' | 'dots'

export interface Expression {
  id: InternalExpressionId
  zh: string
  en: string
  hint: string // 一句人话：这个表情怎么读
  L: EyeShape // 观者左边那只眼（3/4 视角里偏远、偏窄的那只）
  R: EyeShape
  gaze: [number, number] // 视线偏置 [yaw, pitch]（度）
  follow: number // 受光标吸引的程度 0..1
  split: number // 两眼间距倍率
  blush: number // 腮红深浅 0..1
  brow?: [BrowShape, BrowShape] // 观者左 / 右；没有 = 平常的淡眉毛
  cheek?: Partial<CheekShape>
  act?: Act
  posture: Posture
  temper: Partial<Temper>
}

/** 睁着的眼睛：两条眼皮都在豆子外面 */
export const OPEN_EYE: EyeShape = { size: 1, tOff: -1.3, tSlope: 0, tBow: 0, bOff: 1.3, bSlope: 0, bBow: 0, arc: 0, flat: 0, chev: 0 }
const eye = (o: Partial<EyeShape> = {}): EyeShape => ({ ...OPEN_EYE, ...o })
/** 平常的眉毛：淡淡的、微弯（小头像里不画，见 face.ts drawBrow） */
export const REST_BROW: BrowShape = { on: 0.7, lift: 0, tilt: 0, arch: 0.22 }
export const REST_CHEEK: CheekShape = { lift: 0, wide: 1, lines: 0 }
const brow = (o: Partial<BrowShape> = {}): BrowShape => ({ ...REST_BROW, on: 1, ...o })
const brows = (l: Partial<BrowShape>, r: Partial<BrowShape> = l): [BrowShape, BrowShape] => [brow(l), brow(r)]

// ───── 进场动作的小词汇（t = 进入表情后的秒数）─────
const sstep = smoothstep
/** 0 → 1，带阻尼过冲（t0 时松手的弹簧） */
const springTo = (t: number, t0: number, w = 9, z = 0.45) => {
  if (t <= t0) return 0
  const x = t - t0,
    wd = w * Math.sqrt(1 - z * z)
  return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * x))
}
/** [a, b] 上的一个鼓包 0 → 1 → 0 */
const hump = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)))
/** 起跳到落地的抛物线 0 → 1 → 0 */
const arcOf = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : 4 * ((t - a) / (b - a)) * (1 - (t - a) / (b - a)))
/** 动作结束前把盖过去的权重交还给弹簧 */
const handBack = (t: number, dur: number) => 1 - sstep(dur - 0.3, dur, t)
const POSE: Posture = { sy: 1, sx: 1, lean: 0, roll: 0, turn: 0, nod: 0, puff: 0, wl: 0, wr: 0 }
/** w = 两边翅膀同时的位置的简写 */
const pose = (o: Partial<Posture> & { w?: number } = {}): Posture => {
  const { w, ...rest } = o
  return { ...POSE, ...(w !== undefined ? { wl: w, wr: w } : {}), ...rest }
}

export const EXPRESSIONS: (Expression & { id: ExpressionId })[] = [
  {
    id: 'neutral',
    zh: '平静',
    en: 'Neutral',
    hint: '默认脸：两颗暖棕豆眼，淡淡的眉毛和一点腮红',
    L: eye(),
    R: eye(),
    gaze: [0, 0],
    follow: 1,
    split: 1,
    blush: 0.18,
    posture: pose(),
    temper: {}
  },
  {
    id: 'attentive',
    zh: '专注',
    en: 'Attentive',
    hint: '眼皮微降、头略低，视线稳住不乱晃',
    L: eye({ size: 0.96, tOff: -0.78 }),
    R: eye({ size: 0.96, tOff: -0.78 }),
    gaze: [0, 2],
    follow: 0.35,
    split: 1,
    blush: 0,
    brow: brows({ lift: -0.08, tilt: -0.05 }),
    posture: pose({ nod: 6, sy: 0.992, w: -0.08 }),
    temper: { blink: 0.5, sway: 2 }
  },
  {
    id: 'surprised',
    zh: '惊讶',
    en: 'Surprised',
    hint: '眼睛猛地睁大，整个身子被"提"起来一下',
    L: eye({ size: 1.24 }),
    R: eye({ size: 1.24 }),
    gaze: [0, -2],
    follow: 0.6,
    split: 1.04,
    blush: 0,
    brow: brows({ lift: 0.5, arch: 0.5 }),
    posture: pose({ sy: 1.05, sx: 0.975, nod: -9, lean: -10, puff: -0.02, w: 0.85 }),
    temper: { blink: 0.3 },
    act: { dur: 0, kick: { hop: 0.5, squash: -1 }, fx: [{ at: 0, kind: 'bang' }] }
  },
  {
    id: 'excited',
    zh: '兴奋',
    en: 'Excited',
    hint: '大眼发亮，忍不住一下一下地蹦',
    L: eye({ size: 1.15, bOff: 1.05 }),
    R: eye({ size: 1.15, bOff: 1.05 }),
    gaze: [0, -3],
    follow: 0.7,
    split: 1.02,
    blush: 0.35,
    brow: brows({ lift: 0.35, arch: 0.45 }),
    posture: pose({ sy: 1.02, w: 0.35 }),
    temper: { bounce: 34, bounceHz: 1.5, blink: 0.8, sway: 9, swayHz: 0.5, flap: 0.5, flapHz: 3 },
    // 一进来蹦一下撒星星，还兴奋着就隔 1.6s 左右再撒两颗
    act: { dur: 0, kick: { hop: 0.9 }, fx: [{ at: 0, kind: 'spark' }, { at: 0, kind: 'spark' }], every: 1.6 }
  },
  {
    id: 'happy',
    zh: '开心',
    en: 'Happy',
    hint: '跳起来原地转一圈、张开翅膀；之后翅膀半张、笑眼、挑眉、腮红',
    // 笑眼：下眼皮被脸颊顶成弯月，豆子还看得见
    L: eye({ size: 0.98, bOff: 0.62, bBow: -0.66 }),
    R: eye({ size: 0.98, bOff: 0.62, bBow: -0.66 }),
    gaze: [0, 0],
    follow: 0.7,
    split: 1,
    blush: 0.62,
    brow: brows({ lift: 0.22, arch: 0.42, tilt: 0.05 }),
    cheek: { lift: 0.3, wide: 1.08 },
    posture: pose({ sy: 1.01, nod: -6, w: 0.85 }),
    temper: {},
    // 蹲 0.12–0.34s · 起跳 0.27s、落地 0.62s · 跳在空中原地转一圈（0.3–0.95s，yaw；装扮不让转时 engine 置 0）
    // 翅膀甩开到 66° 再收回 30° · 跳的那一下眼睛笑成 ^ ^
    act: {
      dur: 1.4,
      at(t, o) {
        const crouch = hump(t, 0.12, 0.34)
        const land = hump(t, 0.6, 0.78)
        const lift = hump(t, 0.27, 0.45)
        const tw = Math.max(0, t - 0.72)
        const joy = sstep(0.22, 0.3, t) * (1 - sstep(0.78, 0.95, t))
        o.hop = arcOf(t, 0.27, 0.62) * 40
        o.sy = -0.06 * crouch + 0.05 * lift - 0.06 * land
        o.sx = 0.035 * crouch - 0.025 * lift + 0.04 * land
        o.roll = t > 0.72 ? 6 * Math.exp(-4 * tw) * Math.sin(tw * 14) : 0
        o.nod = -8 * joy
        o.yaw = 360 * sstep(0.3, 0.95, t)
        o.wing = -8 * crouch + (66 + (30 - 66) * sstep(0.75, 1.35, t)) * springTo(t, 0.24, 11, 0.38)
        o.wingK = handBack(t, 1.4)
        o.eye = { arc: 0.8 }
        o.eyeK = joy
        o.brow = 0.2 * joy
        o.cheek = 0.28 * joy
      }
    }
  },
  {
    id: 'laughing',
    zh: '大笑',
    en: 'Laughing',
    hint: '眼睛弯成 ^ ^、眉毛高挑、腮红带红晕线；身子后仰一抖一抖，翅膀拍肚子，几下后停',
    L: eye({ arc: 1 }),
    R: eye({ arc: 1 }),
    gaze: [0, 0],
    follow: 0.3,
    split: 1.02,
    blush: 0.95,
    brow: brows({ lift: 0.48, arch: 0.55, tilt: 0.12 }),
    cheek: { lift: 0.5, wide: 1.2, lines: 0.75 },
    posture: pose({ lean: -16, nod: -11, w: 0.45 }),
    temper: { blink: 0 },
    // 每秒笑 3.8 下、越笑越轻，约 6 下后停；身子先往后仰得多一点，再回到静止姿态
    act: {
      dur: 1.6,
      at(t, o) {
        const ph = Math.max(0, t - 0.15)
        const decay = Math.exp(-1.3 * ph) * (1 - sstep(1.35, 1.6, t))
        const beat = Math.sin(ph * Math.PI * 2 * 3.8)
        const b2 = beat * beat
        const env = sstep(0, 0.18, t) * (1 - sstep(1.2, 1.6, t))
        o.hop = 20 * Math.abs(beat) * decay
        o.sy = -0.07 * b2 * decay
        o.sx = 0.04 * b2 * decay
        o.lean = -24 * env
        o.nod = -11 * env
        o.roll = 4 * Math.sin(ph * Math.PI * 2 * 1.9) * decay
        o.wingAdd = -30 * b2 * decay
      }
    }
  },
  {
    id: 'angry',
    zh: '生气',
    en: 'Angry',
    hint: '眼皮从外往内压下来，身子绷紧、微微发颤',
    L: eye({ size: 0.95, tOff: -0.6, tSlope: 0.9 }),
    R: eye({ size: 0.95, tOff: -0.6, tSlope: 0.9 }),
    gaze: [0, 3],
    follow: 0.3,
    split: 0.97,
    blush: 0,
    brow: brows({ lift: -0.15, tilt: -0.45, arch: -0.05 }),
    posture: pose({ sy: 0.985, sx: 1.02, nod: 7, w: -0.28 }),
    temper: { tremor: 3, blink: 0.4, sway: 1 },
    act: { dur: 0, kick: { shake: 1, squash: 0.6 } }
  },
  {
    id: 'sad',
    zh: '难过',
    en: 'Sad',
    hint: '眼皮外侧垂下去，头低低的，像泄了点气',
    L: eye({ size: 0.98, tOff: -0.55, tSlope: -0.9 }),
    R: eye({ size: 0.98, tOff: -0.55, tSlope: -0.9 }),
    gaze: [0, 10],
    follow: 0.12,
    split: 1,
    blush: 0,
    brow: brows({ lift: 0.05, tilt: 0.45, arch: 0.1 }),
    posture: pose({ sy: 0.972, sx: 1.015, nod: 11, roll: -3, w: -0.6 }),
    temper: { breath: 0.007, breathHz: 0.3, blink: 0.6, sway: 2 },
    act: { dur: 0, kick: { squash: 1 } }
  },
  {
    id: 'scared',
    zh: '害怕',
    en: 'Scared',
    hint: '豆眼缩小、眼距拉开，缩着身子发抖',
    L: eye({ size: 0.8 }),
    R: eye({ size: 0.8 }),
    gaze: [-4, -4],
    follow: 0.2,
    split: 1.12,
    blush: 0,
    brow: brows({ lift: 0.35, tilt: 0.4 }),
    posture: pose({ sy: 0.98, lean: 12, nod: 4, sx: 1.01, w: -0.45 }),
    temper: { tremor: 6.5, blink: 1.6, scan: 6, scanHz: 1.7, sway: 0, flap: 0.18, flapHz: 9 },
    act: { dur: 0, kick: { shake: 1.2, squash: 0.8 }, fx: [{ at: 0, kind: 'sweat' }] }
  },
  {
    id: 'suspicious',
    zh: '怀疑',
    en: 'Suspicious',
    hint: '一只眼眯起来，斜着眼打量',
    L: eye({ size: 0.97, tOff: -0.15, tSlope: 0.3 }),
    R: eye({ size: 0.92, tOff: -0.58, tSlope: -0.12 }),
    gaze: [15, 0],
    follow: 0.3,
    split: 1,
    blush: 0,
    brow: brows({ lift: 0.2 }, { lift: -0.2, tilt: -0.25 }),
    posture: pose({ roll: -5, lean: 8, nod: 3, wl: -0.1, wr: 0.38 }),
    temper: { blink: 0.5, sway: 3 }
  },
  {
    id: 'confused',
    zh: '困惑',
    en: 'Confused',
    hint: '两只眼大小不一，头歪向一边',
    L: eye({ size: 1.12 }),
    R: eye({ size: 0.84, tOff: -0.38, tSlope: -0.4 }),
    gaze: [0, -8],
    follow: 0.35,
    split: 1,
    blush: 0,
    brow: brows({ lift: 0.35, arch: 0.4 }, { lift: -0.1, tilt: 0.2 }),
    posture: pose({ roll: 9, lean: 6, wl: 0.42, wr: -0.08 }),
    temper: { sway: 8, swayHz: 0.22 },
    act: { dur: 0, fx: [{ at: 0, kind: 'ques' }] }
  },
  {
    id: 'curious',
    zh: '好奇',
    en: 'Curious',
    hint: '眼睛睁得圆圆的，头歪过去凑近看',
    L: eye({ size: 1.13 }),
    R: eye({ size: 1.13 }),
    gaze: [0, 0],
    follow: 1,
    split: 1,
    blush: 0.08,
    brow: brows({ lift: 0.25 }, { lift: 0.1 }),
    posture: pose({ roll: 8, lean: 11, sy: 1.015, w: 0.18 }),
    temper: { bounce: 4, bounceHz: 0.9, blink: 0.7, sway: 5, swayHz: 0.3 }
  },
  {
    id: 'proud',
    zh: '得意',
    en: 'Proud',
    hint: '闭着眼仰起头「哼～」：下巴抬、胸脯挺、翅膀叉腰，一边眉毛挑起来',
    // 闭成两道向下弯的弧（两条眼皮合拢，同眨眼合上的那一刻）；❌ 双眼往鼻梁压（32px 会读成生气）
    L: eye({ tOff: 0.16, tBow: 0.32, bOff: 0.42, bBow: 0.3 }),
    R: eye({ tOff: 0.16, tBow: 0.32, bOff: 0.42, bBow: 0.3 }),
    gaze: [0, -3],
    follow: 0.4,
    split: 1,
    blush: 0.4,
    brow: brows({ lift: 0.3, arch: 0.5 }, { lift: 0.5, arch: 0.62 }),
    cheek: { lift: 0.22 },
    posture: pose({ nod: -24, lean: -26, puff: 0.05, sy: 1.025, w: -0.62 }),
    temper: { blink: 0, breath: 0.014, breathHz: 0.36 },
    act: {
      dur: 1.0,
      fx: [{ at: 0.32, kind: 'spark' }],
      at(t, o) {
        o.puff = 0.04 * hump(t, 0.12, 0.7)
        o.sy = 0.015 * hump(t, 0.12, 0.7)
        o.browR = 0.22 * hump(t, 0.28, 0.62)
      }
    }
  },
  {
    id: 'shy',
    zh: '害羞',
    en: 'Shy',
    hint: '豆眼缩小、视线躲开，脸颊泛红',
    L: eye({ size: 0.9, tOff: -0.55 }),
    R: eye({ size: 0.9, tOff: -0.55 }),
    gaze: [17, 12],
    follow: 0.12,
    split: 1,
    blush: 1,
    brow: brows({ lift: 0.05, tilt: 0.3 }),
    posture: pose({ sy: 0.98, roll: -6, nod: 8, lean: -6, w: -0.2 }),
    temper: { sway: 9, swayHz: 0.3, blink: 1.3 }
  },
  {
    id: 'unimpressed',
    zh: '无感',
    en: 'Unimpressed',
    hint: '二次元眯眯眼 ‒ ‒：眼睛合成两道平线，眉毛放平压低，轻轻「呼」地沉一下',
    // 平线眼也还站着、有翅膀有脚，和离线时蜷成的睡团分得开
    L: eye({ flat: 1, tOff: -0.2, bOff: 0.4 }),
    R: eye({ flat: 1, tOff: -0.2, bOff: 0.4 }),
    gaze: [0, 2],
    follow: 0.5,
    split: 1,
    blush: 0,
    brow: brows({ lift: -0.18, arch: 0 }),
    posture: pose({ sy: 0.99, nod: 3, w: -0.17 }),
    temper: { breath: 0.005, blink: 0, sway: 1 },
    act: {
      dur: 0.9,
      at(t, o) {
        const sigh = hump(t, 0.25, 0.9)
        o.sy = -0.022 * sigh
        o.sx = 0.01 * sigh
      }
    }
  },
  {
    id: 'sleepy',
    zh: '犯困',
    en: 'Sleepy',
    hint: '眼皮沉、眉梢垂；打盹栽一下、头顶冒 z，一激灵又醒过来',
    L: eye({ tOff: -0.02, tBow: 0.28, bOff: 1.2 }),
    R: eye({ tOff: -0.02, tBow: 0.28, bOff: 1.2 }),
    gaze: [0, 6],
    follow: 0.1,
    split: 1,
    blush: 0.32,
    brow: brows({ lift: -0.1, tilt: 0.3, arch: 0.12 }),
    cheek: { lift: 0.05 },
    posture: pose({ nod: 10, sy: 0.985, w: -0.23 }),
    temper: { breath: 0.02, breathHz: 0.26, blink: 0, sway: 3 },
    // 进入时演一次：眼皮越来越沉、头往下栽（0.25–1.2s），头顶依次冒三个 z；栽到底一激灵：睁眼、眉毛弹起、轻跳，再慢慢回到半睁，然后停住
    act: {
      dur: 2.4,
      fx: [
        { at: 0.3, kind: 'z' },
        { at: 0.8, kind: 'z' },
        { at: 1.3, kind: 'z' }
      ],
      at(t, o) {
        const doze = sstep(0.25, 1.2, t) * (1 - sstep(1.2, 1.28, t))
        const snap = springTo(t, 1.22, 14, 0.4) * (1 - sstep(1.45, 2.3, t))
        o.eye = { tOff: -0.02 + 0.44 * doze - 0.5 * snap, tBow: 0.28 * (1 - snap) }
        o.eyeK = handBack(t, 2.4)
        o.brow = 0.38 * snap - 0.08 * doze
        o.nod = 26 * doze - 12 * snap
        o.roll = 7 * doze * (1 - snap)
        o.sy = -0.015 * doze + 0.012 * snap
        o.hop = 14 * hump(t, 1.22, 1.42)
        o.wingAdd = 14 * hump(t, 1.22, 1.6)
      }
    }
  }
]

/** 睡着：两线并拢成一道向下的弯月 ‿（不在 16 种里，只给"不在线/已移除"用） */
export const ASLEEP: Expression = {
  id: 'asleep',
  zh: '睡着',
  en: 'Asleep',
  hint: '闭眼',
  // 上下两线同弧度、相隔 0.55 个眼高 = 一道等粗的弯弧（设计稿的闭眼是一道粗弧 ‿，不是发丝，也不是两头尖的月牙）。数值按设计稿 09 的弧量出：宽≈眼宽、深≈0.9 眼高
  L: eye({ size: 1, tOff: -0.685, tBow: 0.91, bOff: -0.135, bBow: 0.91 }),
  R: eye({ size: 1, tOff: -0.685, tBow: 0.91, bOff: -0.135, bBow: 0.91 }),
  gaze: [0, 8],
  follow: 0,
  split: 1,
  blush: 0.1,
  posture: pose({ nod: 12, sy: 0.972, sx: 1.012, lean: -4, w: -0.5 }),
  temper: { breath: 0.02, breathHz: 0.22, blink: 0, sway: 0 },
  act: { dur: 0, fx: [{ at: 0, kind: 'z' }], every: 2.2 }
}

/** 委屈（出错塌下去之后）：眼睛还是圆圆的，只有外侧轻轻往下垂一点——不是「难过」那种削掉半个眼睛的三角（会显得阴） */
export const WOE: Expression = {
  id: 'woe',
  zh: '委屈',
  en: 'Woe',
  hint: '圆圆的眼睛，外侧轻轻垂一点',
  L: eye({ size: 1, tOff: -0.95, tSlope: -0.38 }),
  R: eye({ size: 1, tOff: -0.95, tSlope: -0.38 }),
  gaze: [0, 5],
  follow: 0.1,
  split: 1,
  blush: 0,
  posture: pose({ sy: 0.985, nod: 6, w: -0.5 }),
  temper: { breath: 0.01, breathHz: 0.3, blink: 0.6, sway: 1 }
}

export const EXPRESSION_BY_ID: Record<InternalExpressionId, Expression> = Object.fromEntries(
  [...EXPRESSIONS, ASLEEP, WOE].map((e) => [e.id, e])
) as Record<InternalExpressionId, Expression>

// ───────────── 14 种展示状态（抄 presentAgentStatus，不自己编） ─────────────
export type DisplayStateId =
  | 'running'
  | 'parked'
  | 'needsApproval'
  | 'needsAnswer'
  | 'needsPlanReview'
  | 'needsAction'
  | 'error'
  | 'done'
  | 'idle'
  | 'online'
  | 'offline'
  | 'archived'
  | 'removed'
  | 'pending'
  | 'none'

/**
 * 「表情自己轮换、眨眼自己定时」:引擎按状态自己的定时器动,与交互无关;状态本身才是产品传进来的。
 * 做法:每个状态一池表情 + 定时换 + 定时眨;数值与选法都是咕咕自己的。
 * - 每个状态一个**表情池**,第 0 个是这个状态的「本位脸」(待机时 = 这只 agent 自己的休息表情,身份层)。
 * - **本位 + 短暂走神**:本位脸停得久(home),到点去池里另一个脸待一小会儿(away),再回本位。
 *   这样一眼看过去仍是这个状态 / 这只 agent 该有的脸,走神只是让它活着。
 * - 每个状态有自己的**眨眼间隔**;`null` = 这个状态不眨眼(身体变成「!」/ 后台三颗点时,眼睛是符号的一部分)。
 * - 轮换只换眼睛,不重演表情的「进场动作」(蹦、抖、特效)。
 * 不在表里的状态(出错、不在线、已移除、无)保持各自固定的脸,不轮换。
 */
export interface Cadence {
  /** 本位脸停多久(秒,[最短, 最长]) */
  home: readonly [number, number]
  /** 走神的脸停多久 */
  away: readonly [number, number]
}

const IDLE_CADENCE: Cadence = { home: [10, 18], away: [3, 6] }
const WAIT_CADENCE: Cadence = { home: [3, 5], away: [1.5, 2.5] }

export const EXPRESSION_CADENCE: Partial<Record<DisplayStateId, Cadence>> = {
  idle: IDLE_CADENCE,
  online: IDLE_CADENCE,
  pending: IDLE_CADENCE,
  running: { home: [3, 6], away: [1.2, 2.4] },
  parked: { home: [6, 10], away: [2, 4] },
  needsApproval: WAIT_CADENCE,
  needsAnswer: WAIT_CADENCE,
  needsPlanReview: WAIT_CADENCE,
  needsAction: WAIT_CADENCE,
  done: { home: [1.8, 3], away: [1.2, 2] }
}

/** 眨眼间隔(秒)。undefined = 沿用引擎原来的节律(出错 / 睡着那几档);null = 不眨眼 */
export const BLINK_CADENCE: Partial<Record<DisplayStateId, readonly [number, number] | null>> = {
  archived: null,
  idle: [4, 9],
  online: [4, 9],
  pending: [4, 9],
  running: [3, 6],
  parked: null,
  needsApproval: null,
  needsAnswer: null,
  needsPlanReview: null,
  needsAction: null,
  done: [2.5, 5]
}

/** 这个状态的表情池(第 0 个 = 本位脸);null = 不轮换。待机池以这只 agent 自己的休息表情打头,旁边配一个温和的搭档。 */
export function expressionPool(
  state: DisplayStateId | null,
  resting: ExpressionId
): readonly ExpressionId[] | null {
  switch (state ?? 'idle') {
    case 'idle':
    case 'online':
    case 'pending':
      return [resting, resting === 'curious' ? 'neutral' : 'curious']
    case 'running':
      return ['attentive', 'suspicious', 'curious']
    case 'parked':
      return ['attentive', 'neutral']
    case 'needsApproval':
    case 'needsAnswer':
      return ['curious', 'surprised']
    case 'needsPlanReview':
      return ['attentive', 'curious']
    case 'needsAction':
      return ['surprised', 'curious']
    case 'done':
      return ['happy', 'excited', 'proud']
    default:
      return null
  }
}

/** 下一个池下标:在本位(0)就随机去一个走神的脸;在走神就回本位。r ∈ [0,1) */
export function nextPoolIndex(len: number, idx: number, r: number): number {
  if (len < 2 || idx !== 0) return 0
  return 1 + Math.floor(r * (len - 1))
}

export type StateTone =
  | 'running'
  | 'parked'
  | 'needs_user'
  | 'error'
  | 'done'
  | 'idle'
  | 'online'
  | 'offline'
  | 'archived'
  | 'removed'
  | 'pending'
  | 'none'
export type Family = 'idle' | 'work' | 'park' | 'wait' | 'error' | 'done' | 'away'

export interface DisplayState {
  id: DisplayStateId
  zh: string // 咕咕 zh-CN common.agentStatus.*
  tone: StateTone
  color: string | null // 抄 tokens.css：在跑/后台=#ff5f1f，需要你=--warn #f59e0b，出错/已移除=--danger #ef4444，在线=--green #16a34a，不在线/确认中=灰；做完/空闲/不可用=不上色
  animate: boolean // 仅"运行中"字形会转
  emphasis: boolean // 仅"做完了"未读加粗
  family: Family
  glyph: 'spinner' | 'dot' | null // 会话页字形：运行/后台=转圈（后台静止），需要你/出错=点
}

const MUTED = '#9ca3af'
export const STATES: DisplayState[] = [
  {
    id: 'running',
    zh: '运行中',
    tone: 'running',
    color: '#ff5f1f',
    animate: true,
    emphasis: false,
    family: 'work',
    glyph: 'spinner'
  },
  {
    id: 'parked',
    zh: '后台运行中',
    tone: 'parked',
    color: '#ff5f1f',
    animate: false,
    emphasis: false,
    family: 'park',
    glyph: 'spinner'
  },
  {
    id: 'needsApproval',
    zh: '等你批准',
    tone: 'needs_user',
    color: '#f59e0b',
    animate: false,
    emphasis: false,
    family: 'wait',
    glyph: 'dot'
  },
  {
    id: 'needsAnswer',
    zh: '等你回答',
    tone: 'needs_user',
    color: '#f59e0b',
    animate: false,
    emphasis: false,
    family: 'wait',
    glyph: 'dot'
  },
  {
    id: 'needsPlanReview',
    zh: '等你看计划',
    tone: 'needs_user',
    color: '#f59e0b',
    animate: false,
    emphasis: false,
    family: 'wait',
    glyph: 'dot'
  },
  {
    id: 'needsAction',
    zh: '需要你处理',
    tone: 'needs_user',
    color: '#f59e0b',
    animate: false,
    emphasis: false,
    family: 'wait',
    glyph: 'dot'
  },
  {
    id: 'error',
    zh: '出错了',
    tone: 'error',
    color: '#ef4444',
    animate: false,
    emphasis: false,
    family: 'error',
    glyph: 'dot'
  },
  {
    id: 'done',
    zh: '做完了',
    tone: 'done',
    color: null,
    animate: false,
    emphasis: true,
    family: 'done',
    glyph: null
  },
  {
    id: 'idle',
    zh: '空闲',
    tone: 'idle',
    color: null,
    animate: false,
    emphasis: false,
    family: 'idle',
    glyph: null
  },
  {
    id: 'online',
    zh: '在线',
    tone: 'online',
    color: '#16a34a',
    animate: false,
    emphasis: false,
    family: 'idle',
    glyph: 'dot'
  },
  {
    id: 'offline',
    zh: '不在线',
    tone: 'offline',
    color: MUTED,
    animate: false,
    emphasis: false,
    family: 'away',
    glyph: 'dot'
  },
  {
    id: 'archived',
    zh: '已归档',
    tone: 'archived',
    color: MUTED,
    animate: false,
    emphasis: false,
    family: 'away',
    glyph: 'dot'
  },
  {
    id: 'removed',
    zh: '已移除',
    tone: 'removed',
    color: '#ef4444',
    animate: false,
    emphasis: false,
    family: 'away',
    glyph: 'dot'
  },
  {
    id: 'pending',
    zh: '确认中',
    tone: 'pending',
    color: MUTED,
    animate: false,
    emphasis: false,
    family: 'away',
    glyph: 'dot'
  },
  {
    id: 'none',
    zh: '状态不可用',
    tone: 'none',
    color: null,
    animate: false,
    emphasis: false,
    family: 'away',
    glyph: null
  }
]

export const STATE_BY_ID = Object.fromEntries(STATES.map((s) => [s.id, s])) as Record<
  DisplayStateId,
  DisplayState
>

export const FAMILIES: { id: Family; zh: string; hint: string }[] = [
  { id: 'idle', zh: '空闲', hint: '本体：呼吸、眨眼、视线游走，跟着光标看' },
  {
    id: 'work',
    zh: '干活',
    hint: '身体变成三颗点，一颗接一颗往上跳；中间那颗长着眼睛，盯着正在跳的那颗'
  },
  { id: 'park', zh: '后台', hint: '同样三颗点，停下不跳（和会话页"同一枚字形、静止"一个意思）' },
  { id: 'wait', zh: '等你', hint: '身体拉成一个「!」，眼睛长在上面看着你，隔几秒轻跳一下' },
  { id: 'error', zh: '出错', hint: '先吓得缩成一团，再塌成贴地的一滩' },
  { id: 'done', zh: '做完', hint: '本体开心地跳一下、撒星星，之后眯眼笑着' },
  {
    id: 'away',
    zh: '连不上',
    hint: '不在线=缩成一颗小睡团；确认中=一颗球滚来滚去张望；已移除=同一颗睡团飘起来、变小变淡，一圈星屑；不可用=褪色不动'
  }
]
