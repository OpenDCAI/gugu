/**
 * identity.ts —— 身份层「这是谁」:每只 agent 自己的**身体颜色**与**休息表情**。
 *
 * 由 agent 的用户 id 稳定推出来:同一只 agent 在聊天、通讯录、会话页、手机上永远同一个样子,不存库、不跨端同步。
 * (将来 agent 自己改头像时,再把这两格落成一份可存的「头像基因」;推导结果只是没改过时的默认值。)
 *
 * 原则 —— 有序、小步长、可数(owner:❌ 无序生成一排差距很大的成员):
 *  · 不变的(一眼认出是咕咕):同一个身形与绒面、鼠尾草绿叶子翅膀、橙色小嘴与小脚、黑豆眼。
 *  · 颜色轴:只换**身体**。12 格色相,每格 30°,从奶油的色相(83°)起步;全家同亮度、同彩度
 *    —— 彩度取奶油自己的 0.0487,亮度取 0.895:这是 12 格全部落在 sRGB 色域内的最高亮度(再亮,蓝紫粉几格就得被削色)。
 *    相邻两格只差一步色相,换句话说每一只都是「同一只奶油小鸟,把颜色转了几格」。
 *  · 表情轴:休息表情从 16 种里取 6 种平和、小尺寸也读得对的(平静 专注 开心 好奇 害羞 惊讶)。
 *    其余 10 种不进自动分配:生气 难过 害怕 兴奋 大笑 困惑 怀疑 要么一直在抖、跳、冒特效,要么读成「出事了」;
 *    犯困、无感(两条横线)在小头像里读成睡着,会和「不在线 = 睡着」撞;得意(压平的斜眼)在 32px 里读成生气。
 *    它们仍是合法的休息表情,留给将来 agent 自己挑。
 */
import type { ExpressionId } from './spec'

export interface BodyColor {
  zh: string
  en: string
  /** OKLCH 色相(度) */
  hue: number
}

/** 全家同一个亮度 / 彩度(OKLCH)。 */
export const BODY_LIGHTNESS = 0.895
export const BODY_CHROMA = 0.0487

export const BODY_COLORS: readonly BodyColor[] = [
  { zh: '奶油', en: 'Cream', hue: 83.3 },
  { zh: '抹茶', en: 'Matcha', hue: 113.3 },
  { zh: '青芽', en: 'Sprout', hue: 143.3 },
  { zh: '薄荷', en: 'Mint', hue: 173.3 },
  { zh: '湖水', en: 'Lagoon', hue: 203.3 },
  { zh: '晴空', en: 'Sky', hue: 233.3 },
  { zh: '雾蓝', en: 'Haze', hue: 263.3 },
  { zh: '薰衣草', en: 'Lavender', hue: 293.3 },
  { zh: '丁香', en: 'Lilac', hue: 323.3 },
  { zh: '樱花', en: 'Sakura', hue: 353.3 },
  { zh: '蜜桃', en: 'Peach', hue: 23.3 },
  { zh: '杏子', en: 'Apricot', hue: 53.3 }
]

/** 自动分配用的 6 种休息表情(顺序无意义,只是 hash 落点)。 */
export const REST_FACES: readonly ExpressionId[] = [
  'neutral',
  'attentive',
  'happy',
  'curious',
  'shy',
  'surprised'
]

export interface AgentIdentity {
  /** BODY_COLORS 的下标 */
  color: number
  rest: ExpressionId
}

/** 没有 id(这一格不对应某个 agent)时的样子:奶油 + 平静。 */
export const DEFAULT_IDENTITY: AgentIdentity = { color: 0, rest: 'neutral' }

/** FNV-1a + murmur3 的收尾搅拌:短串(uuid)取模时低位也够匀。 */
export function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

export function agentIdentity(id: string | null | undefined): AgentIdentity {
  const key = (id ?? '').trim()
  if (!key) return DEFAULT_IDENTITY
  return {
    color: hash32(`color:${key}`) % BODY_COLORS.length,
    rest: REST_FACES[hash32(`rest:${key}`) % REST_FACES.length]
  }
}

// ───────────── 颜色换算(OKLCH → 线性 sRGB) ─────────────

export type Rgb = readonly [number, number, number]

export function oklchToLinearSrgb(L: number, C: number, hueDeg: number): Rgb {
  const h = (hueDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * 素材里奶油身体的参考色(本体素材亮面那一簇的均值 #F6E4C2)。换色 = 每个像素(线性空间)逐通道乘
 * 「目标色 / 参考色」:明暗、绒毛颗粒原样保留,只把奶油换成目标色。翅膀 / 嘴 / 脚不在遮罩里(gl.ts 按色度分)。
 */
export const CREAM_REFERENCE: Rgb = [
  srgbToLinear(246 / 255),
  srgbToLinear(228 / 255),
  srgbToLinear(194 / 255)
]

const tintCache = new Map<number, Rgb>()

/** 着色器用的逐通道比值:目标色 / 奶油参考色(线性空间)。 */
export function bodyTint(color: number): Rgb {
  const idx = ((color % BODY_COLORS.length) + BODY_COLORS.length) % BODY_COLORS.length
  const hit = tintCache.get(idx)
  if (hit) return hit
  const target = oklchToLinearSrgb(BODY_LIGHTNESS, BODY_CHROMA, BODY_COLORS[idx].hue)
  const tint: Rgb = [
    target[0] / CREAM_REFERENCE[0],
    target[1] / CREAM_REFERENCE[1],
    target[2] / CREAM_REFERENCE[2]
  ]
  tintCache.set(idx, tint)
  return tint
}
