/**
 * look.ts —— 一只 agent 的「形象」:身份层的具体取值(身体颜色 + 休息表情 + 装扮),存进它自己的头像字段。
 *
 * 存法:头像字段放一个形象地址 `https://<存储>/storage/v1/object/public/avatars/agent-look/v1/<颜色>.webp?rest=<表情>&wear=<装扮>`。
 *  · wear = 逗号分隔的 `<装扮 id>.<配色序号>`(engine/outfitCatalog.ts):掷骰子 / DIY 之后存下的那一身;`wear=` 为空 = 明确选了不戴;
 *    没有 wear 参数 = 不戴装扮;只有用户掷骰子或 DIY 后保存的 wear 才穿上。
 *    认不出的 id(更新的版本加的)跳过这一件,冲突的留先出现的;
 *  · 新客户端认出这个地址 → 画会动的小鸟(颜色、休息表情按地址),不去加载那张图;
 *  · 老客户端 / 别的消费方只当它是一张普通头像图 → 那个颜色的小鸟定格图(存储里一色一张,所有 agent 共用);
 *  · 只认路径尾巴 `/agent-look/v1/<颜色>.webp`,不认主机:同一个形象在哪套环境都读得出来。
 * 普通 agent 的默认脸由 Boring Avatars 按 id 生成;这些形象地址只在助理路径继续解释成 3D。
 */
import { rendererLogger } from '@/lib/log'
import { BODY_COLORS, REST_FACES, agentIdentity, type AgentIdentity } from './engine/identity'
import { OUTFIT_BY_ID, clashes, wearKey, type WearItem } from './engine/outfitCatalog'
import { ROLL_RULES, pickWear } from './engine/outfitPick'
import { EXPRESSIONS, type ExpressionId } from './engine/spec'

/** wear 不给或 [] = 不戴装扮;非空数组 = 用户保存的装扮 */
export type AgentLook = AgentIdentity & { wear?: readonly WearItem[] }

/** 个人助理未自定义时：奶油色、平静、不戴装扮。 */
export const DEFAULT_ASSISTANT_LOOK: AgentLook = { color: 0, rest: 'neutral' }

const log = rendererLogger('agents/look')

/** avatars 桶里放共用形象定格图的根目录:这下面的东西(任何版本)都不归某一只 agent 所有。 */
export const LOOK_ROOT = 'agent-look'

/** 存储里形象定格图所在的目录(avatars 桶下)。v1 = 当前这只小鸟;换了形象体系就开 v2,旧地址照样读得出。 */
export const LOOK_DIR = `${LOOK_ROOT}/v1`

/** 手选可用的全部 16 种休息表情(顺序 = 术语表顺序)。自动分配只用其中 6 种日常的(REST_FACES)。 */
export const ALL_REST_FACES: readonly ExpressionId[] = EXPRESSIONS.map((e) => e.id)

/** 16 种里除了日常 6 种之外的 10 种:个性强,在列表里很显眼(一直抖、跳、冒特效,或读成出事 / 睡着)。 */
export const BOLD_REST_FACES: readonly ExpressionId[] = ALL_REST_FACES.filter((id) => !REST_FACES.includes(id))

export function colorSlug(color: number): string {
  return BODY_COLORS[color].en.toLowerCase()
}

/** 这个颜色的定格图在 avatars 桶里的对象路径。 */
export function lookObjectPath(color: number): string {
  return `${LOOK_DIR}/${colorSlug(color)}.webp`
}

/** 拼形象地址:那张定格图的公开地址 + 休息表情 + 装扮(没有 wear = 老形象,不写这个参数)。 */
export function buildLookUrl(posterPublicUrl: string, rest: ExpressionId, wear?: readonly WearItem[]): string {
  const base = `${posterPublicUrl.split('?')[0]}?rest=${rest}`
  return wear ? `${base}&wear=${wearKey(wear)}` : base
}

/** wear 参数 → 这一身:认不出的 id / 配色跳过这一件(记一条),和前面已戴的冲突的跳过 */
function parseWear(raw: string): WearItem[] {
  const out: WearItem[] = []
  for (const token of raw.split(',')) {
    if (!token) continue
    const m = /^([a-z][a-z0-9-]*)\.(\d+)$/.exec(token)
    const def = m ? OUTFIT_BY_ID.get(m[1]) : undefined
    const cw = m ? Number(m[2]) : -1
    if (!def || cw >= def.colorways.length) {
      log.warn({ token }, 'skipping unknown outfit in agent look')
      continue
    }
    if (out.some((w) => clashes(OUTFIT_BY_ID.get(w.id)!, def))) {
      log.warn({ token }, 'skipping clashing outfit in agent look')
      continue
    }
    out.push({ id: def.id, cw })
  }
  return out
}

const LOOK_TAIL = /\/agent-look\/v1\/([a-z]+)\.webp(?:\?([^#]*))?(?:#.*)?$/

/** All built-in v1 looks, including older URLs without expression parameters. Custom images stay custom. */
export function isBuiltinAgentAvatarUrl(avatar: string | null | undefined): boolean {
  if (!avatar) return false
  try {
    const url = new URL(avatar)
    return (url.protocol === 'https:' || url.protocol === 'http:') && /\/agent-look\/v1\/[^/]+$/.test(url.pathname)
  } catch {
    return false
  }
}

/** 头像地址 → 形象;不是形象地址(照片 / null / 认不出的颜色或表情)= null。 */
export function parseAgentLook(avatar: string | null | undefined): AgentLook | null {
  if (!avatar) return null
  const m = LOOK_TAIL.exec(avatar.trim())
  if (!m) return null
  const color = BODY_COLORS.findIndex((c) => c.en.toLowerCase() === m[1])
  if (color < 0) return null
  const params = new URLSearchParams(m[2] ?? '')
  const rest = params.get('rest') as ExpressionId | null
  if (!rest || !ALL_REST_FACES.includes(rest)) return null
  const wear = params.get('wear')
  return wear === null ? { color, rest } : { color, rest, wear: parseWear(wear) }
}

/** 这个头像地址是不是一张「形象」(而不是照片)。 */
export function isLookAvatar(avatar: string | null | undefined): boolean {
  return parseAgentLook(avatar) !== null
}

/** 小鸟该长什么样:存了形象就是形象,否则按 id 推。(传了照片的 agent 头像位画照片,不走这里。) */
export function resolveAgentLook(id: string | null | undefined, avatar: string | null | undefined): AgentLook {
  return parseAgentLook(avatar) ?? agentIdentity(id)
}

/** 实际穿着:有保存就按保存的,缺省或空数组都不戴装扮 */
export function wornOf(look: AgentLook): readonly WearItem[] {
  return look.wear ?? []
}

export function sameLook(a: AgentLook | null | undefined, b: AgentLook | null | undefined): boolean {
  return !!a && !!b && a.color === b.color && a.rest === b.rest && (a.wear === undefined) === (b.wear === undefined) && wearKey(a.wear) === wearKey(b.wear)
}

type Rng = () => number

function pickOne<T>(items: readonly T[], rng: Rng): T {
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))]
}

/**
 * 掷骰子 / 出生:挑一个和兄弟们(同一个主人的其它 agent)尽量不撞的形象。
 *  · 颜色:在被用得最少的那几格里随机(12 只以内就是谁都没用过的颜色);avoid 那一格(眼下这只的样子)能避就避,保证骰子一定换个样;
 *  · 表情:日常 6 种里随机,优先同色兄弟没用过的,同样避开 avoid。
 */
export function pickDistinctLook(taken: readonly AgentLook[], avoid: AgentLook | null, rng: Rng): AgentLook {
  const used = new Array<number>(BODY_COLORS.length).fill(0)
  for (const look of taken) used[look.color]++
  const colors = BODY_COLORS.map((_, i) => i).filter((i) => i !== avoid?.color)
  const least = Math.min(...colors.map((i) => used[i]))
  const color = pickOne(colors.filter((i) => used[i] === least), rng)
  const sameColorFaces = new Set(taken.filter((look) => look.color === color).map((look) => look.rest))
  const faces = REST_FACES.filter((f) => f !== avoid?.rest)
  const fresh = faces.filter((f) => !sameColorFaces.has(f))
  return { color, rest: pickOne(fresh.length ? fresh : faces, rng) }
}

/**
 * 掷骰子:颜色、表情照 pickDistinctLook;再抽一身装扮(engine/outfitPick.ts),主件尽量不和兄弟们撞。
 * 结果带着明确的 wear,存下去就是这一身。taken 里兄弟的 wear 由调用方先按 wornOf 定下来。
 */
export function rollLook(taken: readonly AgentLook[], avoid: AgentLook | null, rng: Rng, month = new Date().getMonth()): AgentLook {
  const look = pickDistinctLook(taken, avoid, rng)
  return { ...look, wear: rollWear(look.color, taken, rng, month) }
}

/** 只换装扮(DIY 页签里的骰子):颜色、表情不动 */
export function rollWear(color: number, taken: readonly AgentLook[], rng: Rng, month = new Date().getMonth()): WearItem[] {
  // 兄弟的主件 = 它身上在主件池里的那件(DIY 搭过的,主件不一定排第一)
  const pool = new Set(ROLL_RULES.pool.flatMap((g) => g.ids))
  const mains = taken.flatMap((t) => t.wear?.find((w) => pool.has(w.id))?.id ?? [])
  return pickWear(color, rng, ROLL_RULES, { taken: mains, month })
}
