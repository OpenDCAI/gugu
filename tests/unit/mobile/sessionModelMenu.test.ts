import { describe, expect, it } from 'vitest'
import type { LiveSettingCapability } from '@gugu/session-core/agents/plugins'
import type { SessionOptionGroup, SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import type { SessionModelMenu } from '@main/core/session-timeline/session-model-menu'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { composerTierLabel } from '@renderer/features/sessions/session-config/use-composer-model-options'
import { PLATFORM_RATE_KEY } from '@/session/shared/platform-model-labels'
import { createModelName, createModelOptions, sessionModelView } from '@/mobile/agent-watch/session-model-menu'

// #6845 手机模型选择与桌面同一份装配:组头分出「你的 Codex 模型」与「咕咕提供的模型」,咕咕条目用咕咕目录的名字与倍率,
// 收起时写「咕咕 X」;换法(当场换 / 重开换计费路)与桌面 planModelSwitch 同一个判定。

const codexModelSetting: LiveSettingCapability = {
  channel: 'provider-thread-settings',
  ack: 'ack-read-back',
  busy: 'queue-next-turn',
  reloadRequired: false,
  recovery: 'none',
}

const platformModels = [
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', creditMultiplier: 0.5, contextWindow: null, reasoningEfforts: null, requiresMembership: false, hidden: false },
  { id: 'glm-5.3', displayName: 'GLM-5.3', creditMultiplier: 0.35, contextWindow: null, reasoningEfforts: null, requiresMembership: false, hidden: false },
]

const ownTerra = { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.' }

const rate = (multiplier: string) => translateSessionMessage(PLATFORM_RATE_KEY, { multiplier })
const gugu = (model: string) => translateSessionMessage('composer.platformModelShortName', { model })

describe('#6845 手机会话胶囊的模型那一档 = 桌面会话菜单', () => {
  // 平台会话里 Codex 自报的清单就是网关那一组,却顶着它自带的名字与说明(这正是 F58 分不清的来源)。
  const platformLive: SessionOptionGroup = {
    selected: 'gpt-5.6-terra',
    available: [{ ...ownTerra }, { id: 'glm-5.3', name: 'GLM-5.3' }],
  }
  const platformMenu: SessionModelMenu = {
    conversationSelection: { modelId: 'gpt-5.6-terra' },
    agentName: 'Codex',
    platformModels,
    ownCatalog: { kind: 'ready', models: [ownTerra], selected: 'gpt-5.6-terra', efforts: [], selectedEffort: null },
    ownAuth: { status: { kind: 'authenticated' }, login: null },
    liveSetting: codexModelSetting,
  }

  it('平台会话:两档组头都在;咕咕那档用咕咕目录的名字与倍率,自家那档来自自家目录而不是被票裁过的活清单', () => {
    const view = sessionModelView(platformMenu, platformLive)
    expect(view.groups.map((group) => group.label)).toEqual([
      composerTierLabel('own', 'Codex'),
      composerTierLabel('platform', 'Codex'),
    ])
    expect(view.groups[0].items.map((item) => [item.id, item.name])).toEqual([['gpt-5.6-terra', 'GPT-5.6-Terra']])
    expect(view.groups[1].items.map((item) => [item.id, item.name, item.description])).toEqual([
      ['platform:gpt-5.6-terra', 'GPT-5.6 Terra', rate('×0.5')],
      ['platform:glm-5.3', 'GLM-5.3', rate('×0.35')],
    ])
    expect(view.selectedId).toBe('platform:gpt-5.6-terra')
    expect(view.groups[1].items[0].shortName).toBe(gugu('GPT-5.6 Terra'))
  })

  it('平台会话 + 自家登录已失效:自家那档与桌面菜单一样经 withAuthExpiry 落空,只剩咕咕那档', () => {
    const view = sessionModelView(
      { ...platformMenu, ownAuth: { status: { kind: 'unauthenticated', reason: 'expired' }, login: null } },
      platformLive
    )
    expect(view.groups.map((group) => group.label)).toEqual([composerTierLabel('platform', 'Codex')])
  })

  it('平台会话:同一档当场换(下发活清单里的那个值),换到自己的模型要重开换计费路', () => {
    const view = sessionModelView(platformMenu, platformLive)
    expect(view.plan('platform:glm-5.3')).toEqual({ kind: 'hot', modelId: 'glm-5.3', wireValue: 'glm-5.3' })
    expect(view.plan('gpt-5.6-terra')).toMatchObject({ kind: 'reload', modelId: 'gpt-5.6-terra', source: 'harness' })
  })

  it('自己的会话:自家那档就是活清单,同一档当场换;换到咕咕的模型要重开', () => {
    const view = sessionModelView(
      { conversationSelection: null, agentName: 'Codex', platformModels, ownCatalog: null, ownAuth: null, liveSetting: codexModelSetting },
      { selected: 'gpt-5.6-terra', available: [{ ...ownTerra }, { id: 'gpt-6-astra', name: 'GPT-6-Astra' }] }
    )
    expect(view.groups[0].items.map((item) => item.id)).toEqual(['gpt-5.6-terra', 'gpt-6-astra'])
    expect(view.selectedId).toBe('gpt-5.6-terra')
    expect(view.plan('gpt-6-astra')).toEqual({ kind: 'hot', modelId: 'gpt-6-astra', wireValue: 'gpt-6-astra' })
    expect(view.plan('platform:gpt-5.6-terra')).toMatchObject({ kind: 'reload', modelId: 'gpt-5.6-terra', source: 'platform' })
    expect(view.groups.flatMap((group) => group.items).some((item) => item.disabled)).toBe(false)
  })
})

describe('#6845 新建面(手机新建会话、无宿主 web 新建 Agent)与桌面同一份装配', () => {
  const models: SessionpageSessionCreateModels = {
    harness: 'codex',
    transport: 'acp',
    models: [
      { ...ownTerra, source: 'harness' },
      { id: 'platform:gpt-5.6-terra', name: 'GPT-5.6 Terra', source: 'gugu', credit_multiplier: 0.5 },
    ],
    selected: null,
    efforts: [],
    selectedEffort: null,
    harnessState: 'ready',
    harnessReason: null,
    guguReason: null,
  }

  it('两条同名只差一个连字符的模型:行的第二行与收起时的名字分得开', () => {
    const options = createModelOptions(models, 'Codex')
    expect(options['gpt-5.6-terra']).toMatchObject({ name: 'GPT-5.6-Terra', groupLabel: composerTierLabel('own', 'Codex') })
    expect(options['platform:gpt-5.6-terra']).toMatchObject({
      name: 'GPT-5.6 Terra',
      description: rate('×0.5'),
      groupLabel: composerTierLabel('platform', 'Codex'),
    })
    expect(createModelName(models, 'gpt-5.6-terra')).toBe('GPT-5.6-Terra')
    expect(createModelName(models, 'platform:gpt-5.6-terra')).toBe(gugu('GPT-5.6 Terra'))
    expect(createModelName(models, 'gone')).toBeNull()
  })

  // #7056 手机新建面与桌面同一份装配:要会员的、他在设置「模型」页关掉的都不进下拉。
  it('要会员的、关掉的平台模型不列', () => {
    const options = createModelOptions({
      ...models,
      models: [
        ...models.models,
        { id: 'platform:glm-5.3', name: 'GLM 5.3', source: 'gugu', credit_multiplier: 0.35, requires_membership: true },
        { id: 'platform:grok-4.5', name: 'Grok 4.5', source: 'gugu', hidden: true },
      ],
    }, 'Codex')
    expect(Object.keys(options)).toEqual(['gpt-5.6-terra', 'platform:gpt-5.6-terra'])
  })
})

describe('#7056 手机会话胶囊:正在用的那条要会员了也照列', () => {
  it('会员到期:别的会员模型不列,正在跑的那条留着(触发器写的就是它)', () => {
    const view = sessionModelView(
      {
        conversationSelection: { modelId: 'glm-5.3' },
        agentName: 'Codex',
        platformModels: [
          { ...platformModels[0], requiresMembership: true },
          { ...platformModels[1], requiresMembership: true },
        ],
        ownCatalog: null,
        ownAuth: null,
        liveSetting: codexModelSetting,
      },
      { selected: 'glm-5.3', available: [{ id: 'glm-5.3', name: 'GLM-5.3' }] }
    )
    const ids = view.groups.flatMap((group) => group.items.map((item) => item.id))
    expect(ids).toContain('platform:glm-5.3')
    expect(ids).not.toContain('platform:gpt-5.6-terra')
    expect(view.selectedId).toBe('platform:glm-5.3')
  })
})
