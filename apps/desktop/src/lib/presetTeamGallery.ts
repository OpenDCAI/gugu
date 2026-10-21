import { rendererLogger } from './log'

// 横幅随引用它的代码走(打包器按 import 发文件):「发现」页不挂载时，这 14 张(4.4 MB)就不进任何包。
// 放在 public/ 时不管有没有人用都会原样拷进 dist,手机包也带着。
const BANNER_URLS = import.meta.glob('../assets/team-banners/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>

const galleryLog = rendererLogger('explore/preset-team-gallery')

export interface PresetTeamBanner {
  src: string
  altKey: `team.bannerAlt.${string}`
}

const BANNER_TEAM_IDS = [
  'mindtrip', 'elicit', 'harvey', 'abridge', 'khanmigo', 'flora', 'lindy',
  'glimpse', 'nugget-ai', 'winify-ai', 'n71', 'metagpt', 'noether-seminar', 'dirac-lab',
] as const

export const PRESET_TEAM_BANNER_IDS = Object.freeze([...BANNER_TEAM_IDS])

const reportedMissing = new Set<string>()

/**
 * 白名单之外的 team 没有 banner —— 返回 null,由卡片走「图没加载出来」那条既有分支。
 * `team` 行来自远端 preset_teams 表,运营加一行不该让所有客户端在 render 里抛(#5610 §2.2);
 * 但缺图仍是要被看见的资产缺口,所以每个 id 记一次错误日志(#1624 fail-loud:记账,不冒充)。
 */
function bannerUrl(teamId: string): string {
  const url = BANNER_URLS[`../assets/team-banners/${teamId}.webp`]
  if (!url) throw new Error(`preset team banner file missing for whitelisted team "${teamId}"`)
  return url
}

export function getPresetTeamBanner(teamId: string): PresetTeamBanner | null {
  if (!(BANNER_TEAM_IDS as readonly string[]).includes(teamId)) {
    if (!reportedMissing.has(teamId)) {
      reportedMissing.add(teamId)
      galleryLog.error({ teamId }, `[resolve-fail #1624] preset team banner missing for team "${teamId}"`)
    }
    return null
  }
  return {
    src: bannerUrl(teamId),
    altKey: `team.bannerAlt.${teamId}`,
  }
}
