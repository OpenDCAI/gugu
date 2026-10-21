/**
 * 新账号的第一次打开(product spec,#7348):认识你 → 认识咕咕 → 开通咕咕。
 * 这里只放纯规则:身份怎么存、走到哪一屏。读写库在 app 侧(apps/desktop/src/lib/firstRun.ts)。
 *
 * 进度记在账号上,两格各有归处:
 * - 「认识你」做完 = 账号设置(identity.user_settings,scope 'user')里有了身份 —— 只有本人能读,不进公开名片;
 * - 「认识咕咕」做完 = identity.users.onboarded_at 有值。老账号由迁移一次性补上,所以不补走。
 */

export const OCCUPATION_KEYS = ['student', 'research', 'engineering', 'product', 'design', 'marketing'] as const
export type OccupationKey = (typeof OCCUPATION_KEYS)[number]

/** 选「其他」时写的那一句的上限。 */
export const OCCUPATION_OTHER_MAX = 40

/** 账号上的「身份」:预设之一,或「其他」+ 人写的一句。 */
export type Occupation = { key: OccupationKey } | { key: 'other'; text: string }

export type FirstRunStage = 'profile' | 'intro' | 'done'

export type FirstRunHarness = 'claude' | 'codex'

/** 用户确认选择后记这一格；换设备或中途退出不重复已完成的推荐步骤。 */
export function completedFirstRunHarness(config: Record<string, unknown>): FirstRunHarness[] | null {
  const value = config.firstRunHarness
  if (value === undefined) return null
  if (value === 'claude' || value === 'codex') return [value]
  if (Array.isArray(value) && value.length > 0 && value.every((id) => id === 'claude' || id === 'codex')) return [...new Set(value)]
  throw new Error('user_settings.firstRunHarness is malformed')
}

const PROFILE_KEY = 'profile'

function isOccupationKey(value: unknown): value is OccupationKey {
  return typeof value === 'string' && (OCCUPATION_KEYS as readonly string[]).includes(value)
}

/** 从 scope 'user' 的配置里读身份。没设过 = null;设得不对(手改过库)= throw,❌ 当成没设过让人重填。 */
export function parseOccupation(config: Record<string, unknown>): Occupation | null {
  const profile = config[PROFILE_KEY]
  if (profile === undefined) return null
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('user_settings.profile is malformed')
  const { occupation, occupationText } = profile as { occupation?: unknown; occupationText?: unknown }
  if (occupation === undefined) return null
  if (isOccupationKey(occupation)) return { key: occupation }
  if (occupation === 'other' && typeof occupationText === 'string' && occupationText.trim()) {
    return { key: 'other', text: occupationText.trim() }
  }
  throw new Error('user_settings.profile.occupation is malformed')
}

/** 写回身份:只动 profile 里身份那两格,配置里别的键原样留着(同一行还装着建 agent 的默认值)。 */
export function withOccupation(config: Record<string, unknown>, occupation: Occupation): Record<string, unknown> {
  const current = config[PROFILE_KEY]
  const profile = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  profile.occupation = occupation.key
  if (occupation.key === 'other') profile.occupationText = occupation.text.trim().slice(0, OCCUPATION_OTHER_MAX)
  else delete profile.occupationText
  return { ...config, [PROFILE_KEY]: profile }
}

/** 选「其他」却没写那一句 = 还不算填好。 */
export function occupationComplete(occupation: Occupation | null): occupation is Occupation {
  if (!occupation) return false
  return occupation.key !== 'other' || occupation.text.trim().length > 0
}

/** 走到哪一屏:认识咕咕做完就是走完;否则身份没填 = 认识你,填了 = 认识咕咕。 */
export function firstRunStage(progress: { onboardedAt: string | null; occupation: Occupation | null }): FirstRunStage {
  if (progress.onboardedAt) return 'done'
  return occupationComplete(progress.occupation) ? 'intro' : 'profile'
}
