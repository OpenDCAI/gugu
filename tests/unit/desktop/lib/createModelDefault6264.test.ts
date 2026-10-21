// 远端建 agent 的默认模型(#6264):那台机器上这家 agent 用不了自己的模型时,默认第一个咕咕平台模型 ——
// 一台刚装好的咕咕 server 上 agent 从没登录过,「不指定」就是去撞 401。
import { describe, expect, it } from 'vitest'
import type { SessionpageSessionCreateModels } from '@gugu/session-core/session-record/contract'
import { allGuguHidden, defaultCreateModel } from '../../../../apps/desktop/src/lib/createModelDefault'

const catalog = (over: Partial<SessionpageSessionCreateModels>): SessionpageSessionCreateModels => ({
  harness: 'codex', transport: 'acp', models: [], selected: null, efforts: [], selectedEffort: null,
  harnessState: 'ready', harnessReason: null, guguReason: null, ...over,
})
const own = { id: 'gpt-5.6-terra', name: 'Terra', source: 'harness' as const }
const gugu = { id: 'platform:gpt-5.6-sol', name: 'GPT-5.6 Sol', source: 'gugu' as const }

describe('defaultCreateModel', () => {
  it('自家模型能用 → 不指定,用它自己的默认', () => {
    expect(defaultCreateModel(catalog({ models: [own, gugu] }))).toBeNull()
  })
  it('那台机器上没登录 → 第一个平台模型', () => {
    expect(defaultCreateModel(catalog({ harnessState: 'auth-required', models: [gugu] }))).toBe(gugu.id)
  })
  it('还没装(咕咕 server 首建会当场装上)→ 第一个平台模型', () => {
    expect(defaultCreateModel(catalog({ harnessState: 'not-installed', models: [gugu] }))).toBe(gugu.id)
  })
  it('自家目录报得出、但默认模型在那台机器上没有凭据(codex 没登录)→ 第一个平台模型', () => {
    expect(defaultCreateModel(catalog({ models: [own, gugu], selected: own.id, selectedCredential: 'uncredentialed' }))).toBe(gugu.id)
  })
  // #7056 只取下拉里列着的:要会员的、他在设置里关掉的不当默认 —— 新用户第一句话不该撞上「要会员」。
  it('平台组前几条要会员 / 被关掉 → 跳过,落在能用的那条', () => {
    const membersOnly = { id: 'platform:glm-5.3', name: 'GLM 5.3', source: 'gugu' as const, requires_membership: true }
    const hidden = { id: 'platform:grok-4.5', name: 'Grok 4.5', source: 'gugu' as const, hidden: true }
    expect(defaultCreateModel(catalog({ harnessState: 'auth-required', models: [membersOnly, hidden, gugu] }))).toBe(gugu.id)
    expect(defaultCreateModel(catalog({ harnessState: 'auth-required', models: [membersOnly, hidden] }))).toBeNull()
  })
  it('两组都没有 → 不指定', () => {
    expect(defaultCreateModel(catalog({ harnessState: 'auth-required' }))).toBeNull()
  })
})

// #7056 咕咕那一组空着,是因为他把能用的都关掉了 —— 那一组要说这句,而不是「没有可选的」。
describe('allGuguHidden', () => {
  const locked = { id: 'platform:glm-5.3', name: 'GLM 5.3', source: 'gugu' as const, requires_membership: true }
  it('能用的都关掉了 → 是;要会员的那几条不算', () => {
    expect(allGuguHidden(catalog({ models: [own, { ...gugu, hidden: true }, locked] }))).toBe(true)
  })
  it('还有一条开着 / 本来就一条能用的都没有 → 否', () => {
    expect(allGuguHidden(catalog({ models: [gugu, { ...gugu, id: 'platform:x', hidden: true }] }))).toBe(false)
    expect(allGuguHidden(catalog({ models: [own, locked] }))).toBe(false)
  })
})


describe('factory defaults per engine (#7582)', () => {
  const ds = { id: 'platform:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', source: 'gugu' as const }
  const luna = { id: 'platform:gpt-6-luna', name: 'GPT-6 Luna', source: 'gugu' as const }
  it('prefers the matching default over a logged-in harness and catalog ordering', () => {
    expect(defaultCreateModel(catalog({ harness: 'claude', models: [own, gugu, luna, ds] }))).toBe(ds.id)
    expect(defaultCreateModel(catalog({ models: [own, gugu, ds, luna] }))).toBe(luna.id)
  })
  it('keeps unavailable or hidden defaults out of selection', () => {
    expect(defaultCreateModel(catalog({ models: [own, { ...luna, hidden: true }] }))).toBeNull()
    expect(defaultCreateModel(catalog({ harnessState: 'auth-required', models: [{ ...luna, requires_membership: true }, gugu] }))).toBe(gugu.id)
  })
})
