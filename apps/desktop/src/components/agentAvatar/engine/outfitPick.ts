/**
 * outfitPick.ts —— 「roll 出来就带装扮」的抽法(owner 10-19:要好看、不要太复杂):一件主件,偶尔加一件点缀。
 * 一套抽法(pickWear)、两处用:
 *  · 掷骰子:按 ROLL_RULES 来一次新的随机,结果写进形象地址(look.ts 的 wear);
 *  · 默认装扮:地址里没有 wear 时按 agent id 推导(defaultWear),不写库,哪台设备算出来都一样 —— 永远按 DERIVE_V1。
 * 规则是一份冻结的快照(PickRules):主件池、点缀、排除的组合、每件的位置和配色色板、判据阈值都抄在里面,不读会变的目录。
 * 以后要改抽法:新开一份规则给 ROLL_RULES 用;DERIVE_V1 原地 ❌ 动(没存过装扮的鸟永远按 v1 推导,单测钉着一批 id 的结果)。
 */
import { BODY_COLORS, BODY_LIGHTNESS, hash32 } from './identity'
import type { Slot, WearItem } from './outfitCatalog'

type Rng = () => number

export interface PickRules {
  /** 主件:先按类别抽(权重),再在类别里抽一件 */
  pool: readonly { weight: number; ids: readonly string[] }[]
  /** 某个月(0–11)头上那一类多一件(圣诞帽);只在调用方给了月份时生效 */
  seasonal: { month: number; group: number; id: string } | null
  /** 点缀的概率,以及主件在哪个位置 → 能加哪几件(都不和主件抢地方) */
  accentChance: number
  accents: Partial<Record<Slot, readonly string[]>>
  /** 两件挤在一起、不进随机的组合 */
  excluded: readonly (readonly [string, string])[]
  /** 每件的位置与各配色的色板(下标 = 形象地址里的配色序号) */
  items: Readonly<Record<string, { slot: Slot; swatches: readonly string[] }>>
  /** 融进身体 = 明暗差 < blendL,且是中性色(彩度 < neutralC)或和身体色相差 < blendHue;点缀要是中性色或和主件色相差 < accentHue */
  blendL: number
  blendHue: number
  neutralC: number
  accentHue: number
}

/**
 * 默认装扮的推导规则 v1(2026-10-19)。主件:套装 35 / 头上 45 / 其它 20(owner);墨镜、披风、背包、滑板、雨伞只给 DIY;
 * 排除的 4 对来自产品引擎上的穿模检查(gugu-base evidence/2026-10-19-agent-outfits-step2/):星星发夹压到眼镜右框、
 * 花环前排碰到眼镜上沿、侦探的放大镜和眼镜左框叠成两个圈、蜜蜂套装再加眼镜太花。
 */
export const DERIVE_V1: PickRules = {
  pool: [
    { weight: 0.35, ids: ['set-puppy', 'set-garfield', 'set-bear', 'set-dino', 'set-frog', 'set-bunny', 'set-bee', 'set-wizard', 'set-chef', 'set-detective'] },
    { weight: 0.45, ids: ['beanie', 'crown', 'strawhat', 'tophat', 'partyhat', 'flowercrown', 'bow', 'flower', 'starclip'] },
    { weight: 0.1, ids: ['headphones'] },
    { weight: 0.1, ids: ['scarf', 'bowtie', 'bell'] }
  ],
  seasonal: { month: 11, group: 1, id: 'santahat' },
  accentChance: 0.18,
  accents: {
    costume: ['glasses'],
    head: ['glasses', 'bowtie', 'bell', 'scarf'],
    ears: ['bowtie', 'bell', 'scarf'],
    neck: ['glasses']
  },
  excluded: [
    ['starclip', 'glasses'],
    ['flowercrown', 'glasses'],
    ['set-detective', 'glasses'],
    ['set-bee', 'glasses']
  ],
  items: {
    'set-puppy': { slot: 'costume', swatches: ['#d23a3c', '#3f78c8', '#4f9a5a'] },
    'set-garfield': { slot: 'costume', swatches: ['#e8903a', '#a8a29c', '#8a5a3c'] },
    'set-bear': { slot: 'costume', swatches: ['#9a6a44', '#d8b48a', '#4a4a4a'] },
    'set-dino': { slot: 'costume', swatches: ['#7fae6a', '#8a7ed0', '#d8843c'] },
    'set-frog': { slot: 'costume', swatches: ['#7fb06a', '#e0c048', '#d890b8'] },
    'set-bunny': { slot: 'costume', swatches: ['#f2c4cc', '#a87a50', '#9a9a9a'] },
    'set-bee': { slot: 'costume', swatches: ['#f0c030', '#4a90d0', '#e0603a'] },
    'set-wizard': { slot: 'costume', swatches: ['#6a4aa0', '#b04a5a', '#3a8a7a'] },
    'set-chef': { slot: 'costume', swatches: ['#d23a3c', '#3f78c8', '#4f9a5a'] },
    'set-detective': { slot: 'costume', swatches: ['#9a7a52', '#9a9690', '#7a8a4a'] },
    'flower': { slot: 'head', swatches: ['#f0a0a8', '#9cc4ea', '#f3d36a'] },
    'starclip': { slot: 'head', swatches: ['#f0b43a', '#f0a0b8', '#8cc0ea'] },
    'bell': { slot: 'neck', swatches: ['#d23a3c', '#e6b63c', '#2f4f8a'] },
    'beanie': { slot: 'head', swatches: ['#ec6a5c', '#6f93c9', '#8fb07a', '#d8d2cf'] },
    'crown': { slot: 'head', swatches: ['#f0cf6e', '#efb39a', '#d8d8d8'] },
    'strawhat': { slot: 'head', swatches: ['#e6c48f', '#efe6d6', '#b98a50'] },
    'tophat': { slot: 'head', swatches: ['#4a4a4c', '#8d3236', '#e2ded8'] },
    'partyhat': { slot: 'head', swatches: ['#a9c9ea', '#eab0c8', '#a7dcc6'] },
    'flowercrown': { slot: 'head', swatches: ['#f3b8c8', '#f0a070', '#e8e6e6'] },
    'santahat': { slot: 'head', swatches: ['#d8343a', '#3d7a5a', '#f1a7b5'] },
    'bow': { slot: 'head', swatches: ['#f2a6b6', '#e0505e', '#9cc4ea', '#c3a8e6'] },
    'headphones': { slot: 'ears', swatches: ['#7fa898', '#e3a0b0', '#4a4a4a', '#eee'] },
    'glasses': { slot: 'face', swatches: ['#b07a52', '#4a4440', '#e9a0a8'] },
    'scarf': { slot: 'neck', swatches: ['#d9a93a', '#b2484a', '#4f9ab0', '#e9e2d4'] },
    'bowtie': { slot: 'neck', swatches: ['#d2343c', '#2f4f8a', '#f0c040', '#333'] }
  },
  blendL: 0.2,
  blendHue: 35,
  neutralC: 0.04,
  accentHue: 40
}

/** 掷骰子用的规则。改抽法就换成新的一份;默认装扮不跟着变 */
export const ROLL_RULES: PickRules = DERIVE_V1

// ───────────── 配色判据 ─────────────
function oklab(hex: string): { L: number; C: number; h: number } {
  const v = parseInt(hex.slice(1), 16)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const r = lin(((v >> 16) & 255) / 255),
    g = lin(((v >> 8) & 255) / 255),
    b = lin((v & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

const hueDist = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180)

/** 这个配色会不会融进身体(明暗差不多,而且是中性色或同色系)。深色的熊耳朵在奶油身上照样分得开 */
export function blendsWithBody(swatch: string, color: number, rules: PickRules = ROLL_RULES): boolean {
  const s = oklab(swatch)
  return Math.abs(s.L - BODY_LIGHTNESS) < rules.blendL && (s.C < rules.neutralC || hueDist(s.h, BODY_COLORS[color].hue) < rules.blendHue)
}

const pick = <T>(items: readonly T[], rng: Rng): T => items[Math.min(items.length - 1, Math.floor(rng() * items.length))]

export interface PickOptions {
  /** 兄弟们(同一个主人的其它 agent)此刻的主件:先在用得最少的里面抽 */
  taken?: readonly string[]
  /** 0–11;给了才看季节件(默认推导不给:同一只鸟不能一到 12 月就自己换装) */
  month?: number
}

/** 按 rules 抽一身:主件 + 偶尔一件点缀。抽到的主件和这个身体颜色怎么配都融进去,就换一件重抽 */
export function pickWear(color: number, rng: Rng, rules: PickRules, opts: PickOptions = {}): WearItem[] {
  const item = (id: string) => rules.items[id]
  const okForBody = (id: string) => item(id).swatches.map((_, i) => i).filter((i) => !blendsWithBody(item(id).swatches[i], color, rules))
  for (let attempt = 0; attempt < 24; attempt++) {
    let u = rng()
    const gi = rules.pool.findIndex((g) => (u -= g.weight) < 0)
    const group = gi < 0 ? rules.pool.length - 1 : gi
    let ids = rules.pool[group].ids
    if (rules.seasonal && opts.month === rules.seasonal.month && group === rules.seasonal.group) ids = [...ids, rules.seasonal.id]
    if (opts.taken?.length) {
      const used = (id: string) => opts.taken!.filter((t) => t === id).length
      const least = Math.min(...ids.map(used))
      ids = ids.filter((id) => used(id) === least)
    }
    const id = pick(ids, rng)
    const cws = okForBody(id)
    if (!cws.length) continue
    const main: WearItem = { id, cw: pick(cws, rng) }
    const wear = [main]
    if (rng() < rules.accentChance) {
      const excluded = (a: string) => rules.excluded.some(([x, y]) => (x === id && y === a) || (x === a && y === id))
      const cands = (rules.accents[item(id).slot] ?? []).filter((a) => !excluded(a))
      const acc = cands.length ? pick(cands, rng) : null
      const mainHue = oklab(item(id).swatches[main.cw]).h
      const goes = (sw: string) => oklab(sw).C < rules.neutralC || hueDist(oklab(sw).h, mainHue) < rules.accentHue
      const acws = acc ? okForBody(acc).filter((i) => goes(item(acc).swatches[i])) : []
      if (acc && acws.length) wear.push({ id: acc, cw: pick(acws, rng) })
    }
    return wear
  }
  throw new Error(`no outfit fits body color ${color}`)
}

const derived = new Map<string, readonly WearItem[]>()

/** 默认装扮(DERIVE_V1):按 agent id(和颜色、表情同一个 hash)推出来的那一身。同一个 id + 颜色永远同一身(算过就记住) */
export function defaultWear(id: string, color: number): readonly WearItem[] {
  const key = (id ?? '').trim()
  const memo = `${key}|${color}`
  let wear = derived.get(memo)
  if (!wear) {
    let i = 0
    wear = pickWear(color, () => hash32(`wear:${key}:${i++}`) / 4294967296, DERIVE_V1)
    derived.set(memo, wear)
  }
  return wear
}
