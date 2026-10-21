// 默认头像 = DiceBear · Notionists（CC0、本地生成、确定性 by seed），替代「首字母色块」占位。
// 首字母/渐变色块是设计稿点名的「AI 第一破绽」(D6/D7)；Notionists 是有脸、记得住、可商用、可离线的开源头像。
// 见 issue #961。同一 seed 永远同一张脸（千人千面、IM 规模零撞脸）；按 seed 缓存避免重复生成。
import { createAvatar } from '@dicebear/core'
import { notionists } from '@dicebear/collection'
import { normalizeAvatarUrl, reportInvalidAvatarUrl } from '@gugu/core/shared/ui/avatarUrl'
import { withoutBlend } from './notionistsBlend'
import { agentLookPoster } from '../components/agentAvatar/posters'
import { agentIdentity } from '../components/agentAvatar/engine/identity'
import { parseAgentLook } from '../components/agentAvatar/look'

// DiceBear 标准柔和背景色板：让深色线稿头像在明/暗主题下都清晰（自带浅底，不依赖容器背景）。
const BACKGROUND = ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf']

const cache = new Map<string, string>()

/**
 * 由稳定身份 key 生成确定性 Notionists 头像 data-URI（SVG，几 KB，离线）。
 * @@@2470 空 key 直接抛：以前回落成一个共用的 '?' 脸，会让多个无 key 的身份**静默撞成同一张脸**，
 * 与「缺 key 就 fail loud」的契约相反。调用方必须先自己判空并进空态。
 */
export function dicebearAvatarDataUri(seed: string): string {
  const key = (seed || '').trim()
  if (!key) throw new Error('[Avatar] dicebearAvatarDataUri requires a stable identity key')
  const cached = cache.get(key)
  if (cached) return cached
  const { svg, extra } = createAvatar(notionists, { seed: key, backgroundColor: BACKGROUND }).toJson()
  const uri = `data:image/svg+xml;utf8,${encodeURIComponent(withoutBlend(svg, String(extra.body)))}`
  cache.set(key, uri)
  return uri
}

// @@@2470 头像投影的单一口径，供不走 React `Avatar` 的消费者用（分享海报 canvas 等）。
// 与 Avatar 组件同源，所以同一身份各 surface 逐字同一张脸。三条分支与组件严格一致：
//   ① 自定义头像（上传/显式设置）→ 原样返回，就是身份本身。
//   ② 没有自定义头像（canonical avatar 为 null）→ 按**稳定身份 key** 生成默认脸。
//   ③ 脏哨兵串（"undefined"/"null"，上游插值 bug）或缺身份 key → 返回 null 让调用方画明确空槽。
//      ❌ 绝不用生成脸盖掉②以外的任何异常——那会把上游 bug 变成一张看起来正常的脸。
// identityKey 必须是稳定 id：姓名永远不得当 seed（改名会变脸，且同名会撞脸）。
/**
 * @@@2470 「这个身份有没有自定义头像」的**唯一**判定入口。
 * 返回自定义头像 URL；没有自定义头像返回 null；脏哨兵串同样返回 null 并 fail loud。
 * 任何需要区分「有没有自定义头像」的 surface 都必须走这里 —— 自己内联 normalize +
 * 自己内联 normalize 会漏掉诊断（公开加入页署名行就踩过这个坑）。
 */
export function customAvatarUrl(
  avatar: string | null | undefined,
  surface = 'avatar projection',
): string | null {
  const normalized = normalizeAvatarUrl(avatar)
  if (normalized) return normalized
  if (avatar != null && normalized == null) reportInvalidAvatarUrl(avatar, surface)
  return null
}

export function displayAvatarUrl(
  avatar: string | null | undefined,
  identityKey: string | null | undefined,
  surface = 'avatar projection',
  // 'agent':没有自定义头像时,默认脸是咕咕小鸟的静态定格(<img> 画不了会动的那只;会动的是 components/Avatar 的
  // AgentAvatar),颜色按这只 agent 的身份层(同一只在画布里和这里同色)。真人 / 群仍是上面那张按 id 生成的脸。
  kind: 'human' | 'agent' = 'human',
): string | null {
  // 形象地址(look.ts:颜色 + 休息表情)不是一张要去加载的图:<img> 场景画这个颜色的本地定格,离线、与画布里同色。
  const look = parseAgentLook(normalizeAvatarUrl(avatar))
  if (look) return agentLookPoster(look, (identityKey ?? '').trim())
  const custom = customAvatarUrl(avatar, surface)
  if (custom) return custom
  // 脏哨兵串已在 customAvatarUrl 里诊断过；这里必须同样拒绝生成脸，不能用一张正常的脸盖掉上游 bug。
  if (avatar != null && normalizeAvatarUrl(avatar) == null) return null
  const key = (identityKey ?? '').trim()
  if (!key) {
    console.error(`[Avatar] missing identity key at ${surface} — a generated default face needs a stable id; display name must never seed it`)
    return null
  }
  return kind === 'agent' ? agentLookPoster(agentIdentity(key), key) : dicebearAvatarDataUri(key)
}
