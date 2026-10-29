import { describe, expect, it } from 'vitest'
import type {
  SessionpageSessionCreateModels,
  SessionpageSessionCreateOptions,
} from '@gugu/session-core/session-record/contract'
import {
  createBlocker,
  createPillLabel,
  defaultSelection,
  initialSelection,
  lastUsedDropped,
  reconcileModel,
  selectHarness,
  selectSessionView,
  selectedModelName,
} from '@/mobile/agent-watch/create-session-form'
import { translateSessionMessage } from '@renderer/localization/locale-store'

const options: SessionpageSessionCreateOptions = {
  projects: [{ id: 'p1', name: '验收工作区', path: '/w' }],
  harnesses: [
    { id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general', 'code'], permissionModes: ['read-only', 'edit', 'full-access'] },
    { id: 'claude', name: 'Claude Code', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['plan', 'read-only', 'edit', 'full-access'] },
  ],
  lastUsed: null,
}

const catalog = (harness: string, ids: string[]): SessionpageSessionCreateModels => ({
  harness,
  transport: 'acp',
  models: ids.map((id) => ({
    id,
    name: id.replace('platform:', ''),
    source: id.startsWith('platform:') ? 'gugu' : 'harness',
  })),
  selected: null,
  efforts: [{ id: 'high', name: 'High' }],
  selectedEffort: null,
  harnessState: 'ready',
  harnessReason: null,
  guguReason: null,
})

describe('新建页的模型那一格(#5014 续)', () => {
  it('默认不指定模型:model 为 null,能发,胶囊上不写「默认」;展示不由手机选(那台电脑按「终端」开关定)', () => {
    const selection = defaultSelection(options)
    expect(selection.model).toBeNull()
    expect(selection).not.toHaveProperty('sessionView')
    expect(selection.permissionMode).toBeNull()
    expect(createBlocker(options, selection)).toBeNull()
    expect(createPillLabel(options, selection, catalog('codex', ['gpt-5']))).toBe('验收工作区 · Codex')
  })

  it('选了模型:胶囊第三段写它收起时的名字(咕咕的带「咕咕」,与桌面触发器同词);目录还没到时退回写 id,❌ 不留空', () => {
    const selection = { ...defaultSelection(options), model: 'platform:gpt-6' }
    expect(createPillLabel(options, selection, catalog('codex', ['gpt-5', 'platform:gpt-6']))).toBe(
      `验收工作区 · Codex · ${translateSessionMessage('composer.platformModelShortName', { model: 'gpt-6' })}`,
    )
    expect(selectedModelName(catalog('codex', ['gpt-5']), { ...selection, model: 'gpt-5' })).toBe('gpt-5')
    expect(selectedModelName(null, selection)).toBe('platform:gpt-6')
  })

  it('换 harness 必清模型与推理档;权限档是产品词,新家也给就留、不给才退', () => {
    const picked = { ...defaultSelection(options), model: 'gpt-5', effort: 'high', permissionMode: 'edit' as const }
    expect(selectHarness(picked, 'codex', options)).toBe(picked)
    // edit 两家都声明 ⇒ 留
    expect(selectHarness(picked, 'claude', options)).toEqual({
      projectId: 'p1', harness: 'claude', model: null, effort: null, permissionMode: 'edit',
    })
    // plan 只有 claude 声明 ⇒ 换回 codex 清掉
    const plan = { ...picked, harness: 'claude', permissionMode: 'plan' as const }
    expect(selectHarness(plan, 'codex', options).permissionMode).toBeNull()
  })

  it('推理档:新目录里没有就退回默认;胶囊第四段写它的名字', () => {
    const picked = { ...defaultSelection(options), effort: 'high' }
    expect(reconcileModel(picked, catalog('codex', ['gpt-5']))).toBe(picked)
    expect(reconcileModel({ ...picked, effort: 'ultra' }, catalog('codex', ['gpt-5'])).effort).toBeNull()
    expect(createPillLabel(options, picked, catalog('codex', ['gpt-5']))).toBe('验收工作区 · Codex · High')
  })

  it('新目录到了:选中的模型不在里面就退回默认;目录没到 / 是另一家的不动', () => {
    const picked = { ...defaultSelection(options), harness: 'claude', model: 'opus' }
    expect(reconcileModel(picked, null)).toBe(picked)
    expect(reconcileModel(picked, catalog('codex', ['gpt-5']))).toBe(picked)
    expect(reconcileModel(picked, catalog('claude', ['opus', 'sonnet']))).toBe(picked)
    expect(reconcileModel(picked, catalog('claude', ['sonnet']))).toEqual({ ...picked, model: null })
  })

  // #7056 选中的那条不在下拉里了(这一档要会员了 / 他在设置里关掉了):退回默认,❌ 留着一个列表里找不到的选择。
  it('选中的模型要会员了或被关掉了:退回默认', () => {
    const picked = { ...defaultSelection(options), model: 'platform:glm-5.3' }
    const models = catalog('codex', ['gpt-5', 'platform:glm-5.3'])
    expect(reconcileModel(picked, models)).toBe(picked)
    const locked = { ...models, models: models.models.map((m) => (m.id === 'platform:glm-5.3' ? { ...m, requires_membership: true } : m)) }
    expect(reconcileModel(picked, locked)).toEqual({ ...picked, model: null })
    const hidden = { ...models, models: models.models.map((m) => (m.id === 'platform:glm-5.3' ? { ...m, hidden: true } : m)) }
    expect(reconcileModel(picked, hidden)).toEqual({ ...picked, model: null })
  })
})

describe('phone creation uses the shared available-model default', () => {
  const own = 'gpt-6.1-sol'
  const platform = 'platform:available-model'
  const unsigned = {
    ...catalog('codex', [own, platform]),
    selected: own,
    selectedCredential: 'uncredentialed' as const,
    harnessAuth: 'signed-out' as const,
  }

  it('selects an offered platform model even when the unsigned-in harness lists its own models', () => {
    expect(reconcileModel(defaultSelection(options), unsigned).model).toBe(platform)
    expect(reconcileModel({ ...defaultSelection(options), model: own }, unsigned).model).toBe(platform)
    expect(reconcileModel(selectHarness({ ...defaultSelection(options), harness: 'claude' }, 'codex', options), unsigned).model).toBe(platform)
  })

  it('preserves a valid remembered own choice when signed in and an explicitly chosen own default', () => {
    const signed = { ...unsigned, selectedCredential: 'credentialed' as const, harnessAuth: 'signed-in' as const }
    const remembered = { ...defaultSelection(options), model: own }
    expect(reconcileModel(remembered, signed)).toBe(remembered)
    expect(reconcileModel(defaultSelection(options), signed).model).toBeNull()
    expect(reconcileModel(defaultSelection(options), unsigned, true).model).toBeNull()
    expect(reconcileModel(remembered, unsigned, true)).toBe(remembered)
  })

  it('excludes hidden or membership-only platform defaults and does not confuse a catalogue with sign-in', () => {
    const models = {
      ...unsigned,
      selectedCredential: 'unknown' as const,
      models: [unsigned.models[0]!, { ...unsigned.models[1]!, hidden: true }, { ...unsigned.models[1]!, id: 'platform:locked', requires_membership: true }, { ...unsigned.models[1]!, id: 'platform:offered' }],
    }
    expect(reconcileModel(defaultSelection(options), models).model).toBe('platform:offered')
    expect(reconcileModel({ ...defaultSelection(options), model: platform }, models).model).toBe('platform:offered')
  })
})

describe('新建页沿用这台机器上次那一套(behavior mobile-session-view)', () => {
  const twoProjects: SessionpageSessionCreateOptions = {
    ...options,
    projects: [{ id: 'p1', name: '验收工作区', path: '/w' }, { id: 'p2', name: '任务工作区', path: '/t' }],
  }
  const last = { projectId: 'p2', harness: 'claude', sessionView: 'general' as const, permissionMode: 'plan' as const, model: 'sonnet', effort: 'high' }

  it('没有上次:与默认预选一模一样,没有要说明的', () => {
    expect(initialSelection(options)).toEqual(defaultSelection(options))
    expect(lastUsedDropped(options, initialSelection(options))).toEqual([])
  })

  it('上次那一套都还能用:五格原样沿用,目录到了也不动,没有要说明的', () => {
    const withLast = { ...twoProjects, lastUsed: last }
    const selection = initialSelection(withLast)
    expect(selection).toEqual({ projectId: 'p2', harness: 'claude', permissionMode: 'plan', model: 'sonnet', effort: 'high' })
    expect(reconcileModel(selection, catalog('claude', ['sonnet', 'opus[1m]']))).toBe(selection)
    expect(lastUsedDropped(withLast, selection)).toEqual([])
  })

  it('上次的 harness 这次用不了:回到第一个能用的,项目照样沿用;只报 harness 这一格', () => {
    const withLast: SessionpageSessionCreateOptions = {
      ...twoProjects,
      harnesses: twoProjects.harnesses.map((h) => (h.id === 'claude' ? { ...h, status: 'missing' as const } : h)),
      lastUsed: last,
    }
    const selection = initialSelection(withLast)
    expect(selection).toMatchObject({ projectId: 'p2', harness: 'codex', model: null, effort: null, permissionMode: null })
    expect(lastUsedDropped(withLast, selection)).toEqual(['harness'])
  })

  it('上次的项目不在了:项目回默认并报出来,其余照样沿用', () => {
    const withLast = { ...options, lastUsed: last }
    const selection = initialSelection(withLast)
    expect(selection).toMatchObject({ projectId: 'p1', harness: 'claude', model: 'sonnet' })
    expect(lastUsedDropped(withLast, selection)).toEqual(['project'])
  })

  it('上次的模型不在这次的目录里:目录到了回默认,报模型;推理档还在就留', () => {
    const withLast = { ...twoProjects, lastUsed: { ...last, model: 'claude-sonnet-5' } }
    const reconciled = reconcileModel(initialSelection(withLast), catalog('claude', ['sonnet', 'opus[1m]']))
    expect(reconciled).toMatchObject({ model: null, effort: 'high' })
    expect(lastUsedDropped(withLast, reconciled)).toEqual(['model'])
  })
})

// A chat continuation is usable without pretending Pi has a workspace transcript.
describe('phone creation in the shared form', () => {
  it('accepts an available chat host and still blocks an unreadable harness without a chat', () => {
    const phone = { ...options, harnesses: [{ id: 'pi', name: 'Pi', status: 'available' as const, watchable: false, chatAvailable: true, sessionViews: ['general' as const], permissionModes: [] }] }
    expect(defaultSelection(phone).harness).toBe('pi')
    expect(createBlocker(phone, defaultSelection(phone))).toBeNull()
    const unreadable = { ...phone, harnesses: [{ ...phone.harnesses[0]!, chatAvailable: false }] }
    expect(createBlocker(unreadable, defaultSelection(unreadable))).toBe('no_usable_harness')
  })
})


describe('manual Terminal choice (#944)', () => {
  it('keeps Work as the default even when the previous task used Terminal', () => {
    expect(initialSelection({ ...options, lastUsed: { projectId: 'p1', harness: 'codex', sessionView: 'code', model: null, permissionMode: null, effort: null } })).not.toHaveProperty('sessionView')
  })
  it('resets runtime-specific model choices and removes an unsupported choice when changing harness', () => {
    const picked = selectSessionView({ ...defaultSelection(options), model: 'own-model', effort: 'high' }, 'code')
    expect(picked).toMatchObject({ sessionView: 'code', model: null, effort: null })
    expect(selectSessionView(picked, 'code')).toBe(picked)
    expect(selectHarness(picked, 'claude', options)).not.toHaveProperty('sessionView')
  })
})
