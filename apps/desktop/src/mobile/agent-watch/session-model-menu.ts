import { buildComposerModelGroups, type ComposerModelItem, type ComposerModelOption } from '@gugu/session-ui/react/components'
import type { SessionOptionGroup, SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import type { SessionModelMenu } from '@main/core/session-timeline/session-model-menu'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { isAuthExpired, withAuthExpiry } from '@renderer/lib/stores/harness-auth-expiry'
import { planModelSwitch, type ModelSwitchPlan } from '@renderer/features/sessions/session-config/model-switch-plan'
import { ownModelTierOptions } from '@renderer/features/sessions/session-config/own-model-tier'
import {
  sessionBillingRoute,
  runningPlatformModelId,
} from '@renderer/features/sessions/session-config/platform-model-selection'
import {
  assembleComposerModelOptions,
  composerModelSelection,
  composerSelectedOptionId,
} from '@renderer/features/sessions/session-config/use-composer-model-options'

/**
 * 新建面(手机新建会话、无任务宿主的 web 新建 Agent)的模型清单:宿主报的两组(`source`)喂进同一份装配,
 * 组头、咕咕那一行的倍率、选完收起时的「咕咕 X」都从这里取 —— 与桌面模型菜单逐字同一份。键是宿主给的 id。
 */
export function createModelOptions(
  models: SessionpageSessionCreateModels,
  agentName: string
): Record<string, ComposerModelOption> {
  const own = Object.fromEntries(
    models.models
      .filter((model) => model.source === 'harness')
      .map((model) => [model.id, { name: model.name, ...(model.description ? { description: model.description } : {}) }])
  )
  const gugu = models.models
    .filter((model) => model.source === 'gugu')
    .map((model) => ({
      id: composerModelSelection(model.id).modelId,
      displayName: model.name,
      creditMultiplier: model.credit_multiplier ?? null,
      contextWindow: null,
      requiresMembership: model.requires_membership === true,
      hidden: model.hidden === true,
    }))
  return assembleComposerModelOptions(own, gugu, agentName) ?? {}
}

/** 选完收起时写什么(桌面触发器同一格:咕咕的写「咕咕 X」)。 */
export function createModelName(models: SessionpageSessionCreateModels, id: string): string | null {
  const option = createModelOptions(models, models.harness)[id]
  return option ? (option.shortName ?? option.name) : null
}

export type SessionModelView = {
  groups: Array<{ label: string; items: ComposerModelItem[] }>
  selectedId: string | undefined
  /** 点中一条之后怎么换:当场换 / 重开换计费路 / 到不了 —— 与桌面会话菜单同一个判定。 */
  plan: (optionId: string) => ModelSwitchPlan
  /** 这一档用不了、不进清单的咕咕模型名(#7056)—— 清单底下「升级解锁更多模型」那一行写它们。 */
  lockedModels: string[]
}

/**
 * 手机会话胶囊的模型那一档 —— 桌面会话菜单(acp-chat-panel)那一套原样跑一遍:同样的成员
 * (`ownModelTierOptions`)、同样的装配(组头 / 倍率 / 「咕咕 X」)、同样的高亮与换法(`planModelSwitch`)、
 * 同样把到不了的那几条置灰。输入是宿主送来的同一组事实(session-model-menu)。
 */
export function sessionModelView(menu: SessionModelMenu, live: SessionOptionGroup): SessionModelView {
  const route = sessionBillingRoute(menu.conversationSelection)
  const liveOptions = Object.fromEntries(
    live.available.map((choice) => [choice.id, { name: choice.name, ...(choice.description ? { description: choice.description } : {}) }])
  )
  // 登录已失效叠到自家目录上,与桌面 useHarnessModelCatalog 同一个函数(#6264)。
  const catalog = withAuthExpiry(menu.ownCatalog ?? { kind: 'unknown' }, isAuthExpired(menu.ownAuth))
  const own = ownModelTierOptions({ route, live: liveOptions, catalog })
  const runningPlatformModel = runningPlatformModelId(
    menu.conversationSelection,
    live.selected,
    menu.platformModels.map((model) => model.id)
  )
  // 正在用的那条要会员了、或被他在设置里关掉了也照列(与桌面会话菜单同一条,见 `composerModelOptions`)。
  const options = assembleComposerModelOptions(
    own, menu.platformModels, menu.agentName, undefined, runningPlatformModel
  ) ?? {}
  const advertised = live.available.map((choice) => choice.id)
  const plan = (optionId: string) =>
    planModelSwitch({
      selection: composerModelSelection(optionId),
      advertised,
      catalog: menu.platformModels,
      runningOn: runningPlatformModel ? 'platform' : 'own',
      liveSetting: menu.liveSetting,
    })
  const items = Object.entries(options).map(([id, option]): ComposerModelItem => {
    const kind = plan(id).kind
    if (kind !== 'unavailable' && kind !== 'unsupported') return { ...option, id }
    return {
      ...option,
      id,
      disabled: true,
      disabledReason: translateSessionMessage(
        kind === 'unsupported' ? 'chat.modelSwitchUnsupportedHint' : 'composer.modelNotInCatalog'
      ),
    }
  })
  return {
    groups: buildComposerModelGroups(items),
    selectedId: composerSelectedOptionId({ platformModel: runningPlatformModel, model: live.selected }),
    plan,
    lockedModels: menu.platformModels.filter((model) => model.requiresMembership).map((model) => model.displayName),
  }
}
