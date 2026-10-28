import { useQuery, useQueryClient } from '@tanstack/react-query'
import { readUserSettingsConfig, mutateUserSettingsConfig, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { identityDb } from './supabase'

/**
 * 功能栏导览(规范 4.1 第 6 步):七个功能,按功能栏的顺序。每一步指着一个真实存在的入口;
 * 当前界面上找不到的那一步跳过,总步数跟着少(规范 2.3)。
 */
export const TOUR_STEPS = ['assistant', 'tasks', 'chats', 'contacts', 'library', 'apps', 'settings'] as const
export type TourStepId = (typeof TOUR_STEPS)[number]

/** 功能短片:「通用 / 编程」那一段随 #634 去掉的切换一起下线,剩三段。只从「帮助与导览」里看。 */
export const TOUR_FILMS = ['split', 'contacts', 'report'] as const

/**
 * 导览进度,记在账号上(换设备也接得上)。
 * - active:正在看(中途退出 ❌ 下次自动重放,只在「帮助与导览」里给「继续」—— 规范 4.3)
 * - skipped:按了「跳过」或 Esc,停在 step;❌ 再自动弹出
 * - done:走完
 */
export type ProductTourState = { step: TourStepId; status: 'active' | 'skipped' | 'done' }
const KEY = 'productTour'
const client = identityDb as unknown as SettingsTableClient

/** 没有 = 没看过。格式坏了 throw:❌ 悄悄当成没看过、把人家的进度清零。 */
export function parseProductTourState(config: Record<string, unknown>): ProductTourState | null {
  const value = config[KEY]
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid product tour progress')
  const record = value as Record<string, unknown>
  if (record.version === 2) {
    const { step, status } = record
    if (!TOUR_STEPS.includes(step as TourStepId) || (status !== 'active' && status !== 'skipped' && status !== 'done')) throw new Error('Invalid product tour progress')
    return { step: step as TourStepId, status }
  }
  // 第 1 版(七个气泡 + 四段短片,点「下一步」走):停在气泡上的按跳过算,能从那一步接着看;到了短片阶段的算看完。
  if (record.version === 1) {
    const { phase, index } = record
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new Error('Invalid product tour progress')
    if (phase === 'modules' && index < TOUR_STEPS.length) return { step: TOUR_STEPS[index], status: 'skipped' }
    if (phase === 'features' && index < 4) return { step: TOUR_STEPS[TOUR_STEPS.length - 1], status: 'done' }
  }
  throw new Error('Invalid product tour progress')
}

export async function readProductTourState(userId: string): Promise<ProductTourState | null> {
  return parseProductTourState(await readUserSettingsConfig(client, userId, 'user'))
}

export async function saveProductTourState(userId: string, state: ProductTourState): Promise<void> {
  await mutateUserSettingsConfig(client, userId, 'user', config => ({ ...config, [KEY]: { version: 2, ...state } }))
}

/** 「帮助与导览」发来的请求(UI_EVENTS.reopenProductTour 的 detail)。 */
export type ProductTourRequest = { mode: 'restart' } | { mode: 'resume'; step: TourStepId } | { mode: 'films' }

export const productTourQueryKey = (userId: string) => ['product-tour', userId] as const

/** 「帮助与导览」要知道能不能「从第 n 步继续」;导览自己存进度时同步这一份。 */
export function useProductTourState(userId: string | null) {
  return useQuery({
    queryKey: productTourQueryKey(userId ?? ''),
    queryFn: () => readProductTourState(userId!),
    enabled: !!userId,
    retry: false,
  })
}

export function useRememberProductTourState(userId: string) {
  const queryClient = useQueryClient()
  return (state: ProductTourState) => queryClient.setQueryData(productTourQueryKey(userId), state)
}

/** 从 state 起算「从第几步继续」;看完的、没看过的都没有可继续的。 */
export function resumableStep(state: ProductTourState | null | undefined): TourStepId | null {
  return state && state.status !== 'done' ? state.step : null
}
