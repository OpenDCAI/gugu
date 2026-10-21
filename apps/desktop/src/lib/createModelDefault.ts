import type { SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { offeredInModelPicker } from '@/session/shared/core/agents/platform-model'
import { DEFAULT_FREE_PLATFORM_MODEL, DEFAULT_PLATFORM_MODEL_BY_PROVIDER } from '@/session/shared/core/sessions/new-session-defaults'
import { platformOptionId } from '@/session/shared/platform-model-id'

/**
 * 远端建 agent 时(#6264)模型的默认值,与桌面创建框同一条规则:
 * 先选该引擎的出厂平台模型(Claude → DS 4.1 Flash,Codex → GPT-6 Luna),不可用时再看凭据;
 * 这家 agent 在那台机器上能用自己的模型(已登录、有货)→ 不指定,让它用自己的默认;
 * 用不了(没登录 / 还没装 / 起不来)而咕咕平台有货 → 默认第一个平台模型。
 *
 * 一台刚装好的咕咕 server 上 agent 从没登录过,「不指定」就是去撞 401;平台模型是那里唯一开箱能用的选择。
 */
export function defaultCreateModel(models: SessionpageSessionCreateModels): string | null {
  const preferred = DEFAULT_PLATFORM_MODEL_BY_PROVIDER[models.harness]
  const factoryDefault = preferred && models.models.find((m) =>
    m.source === 'gugu' && m.id === platformOptionId(preferred) && offeredInCreateMenu(m))
  if (factoryDefault) return factoryDefault.id
  const freeDefault = preferred && models.models.find((m) =>
    m.source === 'gugu' && m.id === platformOptionId(DEFAULT_FREE_PLATFORM_MODEL) && offeredInCreateMenu(m))
  if (freeDefault) return freeDefault.id
  // 有的家(codex)没登录也报得出自家目录 —— 所以还要看那台机器报的默认模型凭据读数。
  const harnessUsable = models.harnessState === 'ready'
    && models.models.some((m) => m.source === 'harness')
    && models.selectedCredential !== 'uncredentialed'
  if (harnessUsable) return null
  // 只取下拉里列着的:要会员的、他在设置里关掉的不当默认 —— 新用户第一句话不该撞上「要会员」(#7056)。
  return models.models.find((m) => m.source === 'gugu' && offeredInCreateMenu(m))?.id ?? null
}

/** 宿主送来的一行(蛇形字段)进不进新建页的模型清单 —— 判据就是 `offeredInModelPicker` 那一个。 */
export function offeredInCreateMenu(
  model: SessionpageSessionCreateModels['models'][number]
): boolean {
  return offeredInModelPicker({ requiresMembership: model.requires_membership, hidden: model.hidden })
}

/**
 * 咕咕那一组一条都不剩,是因为他在设置里把能用的都关掉了(#7056)—— 那一组要说清这件事,
 * ❌ 落成「这一组没有可选的」:那句话让人以为咕咕没给他模型,而去路就在清单底下的「管理模型」。
 */
export function allGuguHidden(models: SessionpageSessionCreateModels): boolean {
  const usable = models.models.filter((model) => model.source === 'gugu' && !model.requires_membership)
  return usable.length > 0 && usable.every((model) => model.hidden)
}
