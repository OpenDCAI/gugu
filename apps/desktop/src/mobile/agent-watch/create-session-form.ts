import { readingFromStatus, type InstallationReading } from '@gugu/session-core/deps/runtime/types'
import type {
  SessionpageHarnessOption,
  SessionpagePermissionMode,
  SessionpageSessionCreateModels,
  SessionpageSessionCreateOptions,
  SessionpageSessionCreateResult,
  SessionpageSessionSummary,
} from '@gugu/session-core/session-record/contract'
import { createModelName } from './session-model-menu'
import { offeredInCreateMenu } from '@/lib/createModelDefault'
import { PREFERRED_SESSION_PROVIDERS } from '@/session/shared/core/sessions/new-session-defaults'

/**
 * 新建会话页的纯逻辑:默认选什么、胶囊上写什么、什么时候能发、建成后怎么跳。
 *
 * 单独一份、且是纯函数,理由与 agent-watch-store 同:「不能用的 harness 永远不会被默认选中」
 * 这种事只有在能被反复喂合成输入的地方才验得动 —— 组件里做的话判据只剩「屏幕上看着没选错」。
 */

export type CreateSelection = {
  projectId: string | null
  harness: string | null
  /**
   * 选中的模型 id(`sessionCreateModels` 报的那份里的 id,原样带给机器)。
   * null = 不指定,harness 用它自己的默认 —— 这是**合法的默认值**,不是「还没选」:
   * 目录探不出来(harness 没登录、咕咕那组不在场)时人照样能建会话。
   */
  model: string | null
  /** 咕咕权限档;null = 这家的默认。取值须在所选 harness 的 permissionModes 里。 */
  permissionMode: SessionpagePermissionMode | null
  /** 推理档 id(目录 efforts 里的);null = 引擎默认。换 harness 必清。 */
  effort: string | null
}

/**
 * 只有「装了能起」**且**「手机端读得了它的记录」的 harness 能拿来建会话。
 * `missing` 要去装、`error` 要去修;`watchable:false` 是第三种:建得出来,但建出来手机上打不开
 * (时间线读侧只认 claude / codex / opencode 的记录格式)—— 从手机建一条自己看不了的会话没有意义。
 */
export function harnessUsable(option: Pick<SessionpageHarnessOption, 'status' | 'watchable' | 'chatAvailable'>): boolean {
  return option.status === 'available' && (option.watchable || option.chatAvailable === true)
}

/**
 * 行上写的原因:先说「没装 / 跑不起来」,装好了才轮到「手机端读不了」。
 *
 * 用的是全产品那一套四态读数(#6101)—— 手机端这条通道只报得出 `DependencyStatus`,
 * 所以分不出「你选的那一份不在了」;能分出来的两态与桌面端**同名同词**
 * (词在 i18n 各语言 `main.ts` 的 `agentWatch.create.harnessStatus`,逐格比对见
 * `agent-reading-vocabulary.test.ts`)。`unwatchable` 是另一根轴:装好了、能起,只是
 * 手机端读不了它的记录格式。
 */
export function harnessBlockReason(
  option: Pick<SessionpageHarnessOption, 'status' | 'watchable' | 'chatAvailable'>,
): InstallationReading | 'unwatchable' | null {
  if (option.status !== 'available') return readingFromStatus(option.status)
  if (!option.watchable && !option.chatAvailable) return 'unwatchable'
  return null
}

/**
 * 默认选项:第一个项目 + 第一个**能用**的 harness。
 *
 * 项目取第一个是因为列表就是那台机器自己的顺序,而多数机器只有一两个项目;
 * harness ❌ 不取第一个 —— 第一个可能是没装的那家,默认选中它等于默认选中一个必失败的发送。
 * 一个能用的都没有就留 null,让页面如实说「这台机器上没有能用的 harness」。
 */
export function defaultSelection(options: SessionpageSessionCreateOptions): CreateSelection {
  const project = options.projects[0] ?? null
  const usable = options.harnesses.filter(harnessUsable)
  const harness = PREFERRED_SESSION_PROVIDERS.map((id) => usable.find((h) => h.id === id)).find(Boolean) ?? usable[0] ?? null
  return {
    projectId: project?.id ?? null,
    harness: harness?.id ?? null,
    model: null,
    permissionMode: null,
    effort: null,
  }
}

/** 上次那一套里可能没沿用上的格,按沿用的先后排。 */
export type LastUsedItem = 'project' | 'harness' | 'permissionMode' | 'model' | 'effort'

/**
 * 进页面时的预选(behavior mobile-session-view「新建会话沿用上次的选择」):那台机器报了上次那一套,
 * 就逐格沿用;沿用不了的格回到 `defaultSelection` 的那一格。
 * 模型与推理档先照搬 —— 目录要在那台机器上现探(几秒),到了由 `reconcileModel` 核,不在就回默认。
 * 展示(编程 / 通用)不由手机选:那台电脑按自己的「终端」开关定(手机建的请求不带 sessionView)。
 */
export function initialSelection(options: SessionpageSessionCreateOptions): CreateSelection {
  const fallback = defaultSelection(options)
  const last = options.lastUsed
  if (!last) return fallback
  const projectId = options.projects.some((p) => p.id === last.projectId) ? last.projectId : fallback.projectId
  const harness = options.harnesses.find((h) => h.id === last.harness)
  if (!harness || !harnessUsable(harness)) return { ...fallback, projectId }
  return {
    projectId,
    harness: harness.id,
    permissionMode: last.permissionMode && harness.permissionModes.includes(last.permissionMode) ? last.permissionMode : null,
    model: last.model,
    effort: last.effort,
  }
}

/**
 * 上次那一套里哪几格这次没沿用上 —— 页面据此说一句为什么变了,❌ 不悄悄换掉。
 * 只报**根上**那一格:harness 没沿用上,它下面的权限档 / 模型 / 推理档跟着换是必然,不再逐条报。
 * 只在人还没动过选择时有意义(人自己改的不叫「没沿用上」),由页面把关。
 */
export function lastUsedDropped(options: SessionpageSessionCreateOptions, selection: CreateSelection): LastUsedItem[] {
  const last = options.lastUsed
  if (!last) return []
  const dropped: LastUsedItem[] = selection.projectId === last.projectId ? [] : ['project']
  if (selection.harness !== last.harness) return [...dropped, 'harness']
  if (selection.permissionMode !== last.permissionMode) dropped.push('permissionMode')
  if (selection.model !== last.model) dropped.push('model')
  if (selection.effort !== last.effort) dropped.push('effort')
  return dropped
}

/**
 * 换了 harness,模型选择**必须**跟着清:模型 id 是那家 harness 目录里的,换家之后同一个 id
 * 要么不存在、要么指向另一家的另一个模型(`platform:` 那组按 provider × 腿算)。
 * 带着旧 id 发过去,机器端会拒 —— 但那是发送时才知道,人早就以为选好了。
 */
export function selectHarness(
  selection: CreateSelection,
  harness: string,
  options: SessionpageSessionCreateOptions,
): CreateSelection {
  if (selection.harness === harness) return selection
  const option = options.harnesses.find((h) => h.id === harness)
  // 权限档:新家也给这一档就留(它是咕咕的四档,不是某家的原生 id)。
  const permissionMode =
    selection.permissionMode && option?.permissionModes.includes(selection.permissionMode)
      ? selection.permissionMode
      : null
  return { ...selection, harness, permissionMode, model: null, effort: null }
}

/**
 * 目录换了(换 harness 后新目录到了),选中的模型若已不在下拉里(下架、要会员、在设置里关掉了,#7056)就退回默认。
 * 目录还没到(null)时**不动**:清空一个稍后可能仍然有效的选择只会让人重选一次。
 */
export function reconcileModel(
  selection: CreateSelection,
  models: SessionpageSessionCreateModels | null,
): CreateSelection {
  if (!models || models.harness !== selection.harness) return selection
  const model =
    selection.model !== null && !models.models.some((m) => m.id === selection.model && offeredInCreateMenu(m))
      ? null
      : selection.model
  const effort =
    selection.effort !== null && !models.efforts.some((e) => e.id === selection.effort) ? null : selection.effort
  return model === selection.model && effort === selection.effort ? selection : { ...selection, model, effort }
}

/** 摘要行上推理档那一格写什么:选了写名字(目录没到写 id);没选 null。 */
export function selectedEffortName(
  models: SessionpageSessionCreateModels | null,
  selection: CreateSelection,
): string | null {
  if (selection.effort === null) return null
  return models?.efforts.find((e) => e.id === selection.effort)?.name ?? selection.effort
}

/** 胶囊 / 摘要行上模型那一格写什么:选了写收起名(咕咕的是「咕咕 X」);没选写 null,由界面按「默认」措辞。 */
export function selectedModelName(
  models: SessionpageSessionCreateModels | null,
  selection: CreateSelection,
): string | null {
  if (selection.model === null) return null
  // 目录没到 / 目录里没有:退回写 id —— 选了就得看得见选了什么,❌ 不留空冒充「默认」。
  return (models ? createModelName(models, selection.model) : null) ?? selection.model
}

/** 胶囊上写**值**(项目名 · harness 名),照会话选项胶囊的口径;一个都没有就 null(不画)。 */
export function createPillLabel(
  options: SessionpageSessionCreateOptions,
  selection: CreateSelection,
  models: SessionpageSessionCreateModels | null = null,
  phoneAgentLabel?: string,
): string | null {
  const project = options.projects.find((p) => p.id === selection.projectId)
  const harness = options.harnesses.find((h) => h.id === selection.harness)
  // 模型只在**选了**时上胶囊:默认档不写「默认」二字 —— 胶囊只写值,没值就不占位。
  const model = selectedModelName(models, selection)
  const effort = selectedEffortName(models, selection)
  const parts = (phoneAgentLabel ? [phoneAgentLabel, model, effort] : [project?.name, harness?.name, model, effort]).filter((x): x is string => !!x)
  return parts.length > 0 ? parts.join(' · ') : null
}

export type CreateBlocker = 'no_projects' | 'no_usable_harness' | 'pick_project' | 'pick_harness'

/**
 * 为什么现在还不能发。null = 能发。
 * 顺序按「人先要知道的」:机器上根本没项目 / 没能用的 harness,先于「你还没选」。
 */
export function createBlocker(
  options: SessionpageSessionCreateOptions,
  selection: CreateSelection,
): CreateBlocker | null {
  if (options.projects.length === 0) return 'no_projects'
  if (!options.harnesses.some(harnessUsable)) return 'no_usable_harness'
  if (!options.projects.some((p) => p.id === selection.projectId)) return 'pick_project'
  const harness = options.harnesses.find((h) => h.id === selection.harness)
  if (!harness || !harnessUsable(harness)) return 'pick_harness'
  return null
}

/**
 * 老宿主(建会话不交回摘要)建成了 → 手机直接跳进时间线。列表页平时给时间线页的是 `listSessions` 回的那份摘要,
 * 这里按同一形状自己攒一份:时间线页只用 conversationId 与 title,其余字段如实标「不知道」
 * (runtime 'unknown'、agentStatus null),❌ 不编一个「在跑」—— 那台机器还没报过。
 */
export function toSessionSummary(
  result: SessionpageSessionCreateResult,
  harness: string,
  now: string,
): SessionpageSessionSummary {
  return {
    conversationId: result.conversationId,
    projectId: result.projectId,
    title: result.title,
    harness,
    runtime: 'unknown',
    agentStatus: null,
    lastInteractedAt: now,
    supported: true,
  }
}
