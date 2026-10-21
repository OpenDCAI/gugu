import { describe, expect, it } from 'vitest'
import { pickAssistant, type AssistantProvisionRow } from '../../../../apps/desktop/src/lib/assistantProvision'
import { assistantHomePlace } from '../../../../apps/desktop/src/lib/assistantHome'

const CLOUD = 'dev-cloud'
const MAC = 'dev-mac'
function row(agent: string | null, over: Partial<AssistantProvisionRow> = {}): AssistantProvisionRow {
  return { agent_user_id: agent, device_id: CLOUD, member_key: 'assistant', phase: 'completed', created_at: '2026-10-01T00:00:00Z', ...over } as AssistantProvisionRow
}

// #7199 owner:「它是一个个人级别的 agent……只有一个身份」—— 认它靠库里的标记,❌ 按名字、❌ 按住在哪台机器上
// (owner 10-16:会员住云上、非会员住自己的电脑,升降级 = 搬家)。
describe('pickAssistant', () => {
  it('认 member_key=assistant、已经有身份的那一行,带出建它的那台', () => {
    expect(pickAssistant([row('a')])).toEqual({ agentId: 'a', deviceId: CLOUD })
  })

  it('住在人自己电脑上的那一位一样认得出(非会员在本机开通)', () => {
    expect(pickAssistant([row('a', { device_id: MAC })])).toEqual({ agentId: 'a', deviceId: MAC })
  })

  it('人自己建的别的 agent 不算', () => {
    expect(pickAssistant([row('other', { member_key: 'single' })])).toBeNull()
  })

  it('还没身份的、开通失败或撤回的不算', () => {
    expect(pickAssistant([
      row(null),
      row('failed', { phase: 'failed' }),
      row('cancelled', { phase: 'cancelled' }),
    ])).toBeNull()
  })

  it('不止一行(重开过、搬过家):取最近建的', () => {
    expect(pickAssistant([
      row('first', { created_at: '2026-09-01T00:00:00Z' }),
      row('second', { device_id: MAC, created_at: '2026-10-10T00:00:00Z' }),
    ])).toEqual({ agentId: 'second', deviceId: MAC })
  })

  it('一行都没有 = 没有助理', () => {
    expect(pickAssistant([])).toBeNull()
  })
})

describe('assistantHomePlace', () => {
  const devices = [
    { device_id: MAC, label: 'MacBook', is_online: true, is_current_device: true, cloud_computer: undefined, capabilities: {} },
    { device_id: 'dev-other', label: '家里的 iMac', is_online: false, is_current_device: false, cloud_computer: undefined, capabilities: {} },
    { device_id: 'dev-host', label: '助理', is_online: true, is_current_device: false, cloud_computer: undefined, capabilities: { assistant_home: true } },
  ] as never[]

  it('住在管家说的那台 = 云上', () => {
    expect(assistantHomePlace(CLOUD, devices, CLOUD)).toEqual({ kind: 'cloud', deviceId: CLOUD })
  })

  it('那台自己报是助理的家(管家还没答)= 云上', () => {
    expect(assistantHomePlace('dev-host', devices, null)).toEqual({ kind: 'cloud', deviceId: 'dev-host' })
  })

  it('住在眼前这台电脑上', () => {
    expect(assistantHomePlace(MAC, devices, CLOUD)).toEqual({ kind: 'computer', deviceId: MAC, thisDevice: true, label: 'MacBook', online: true, known: true })
  })

  it('住在另一台电脑上(此刻关着)', () => {
    expect(assistantHomePlace('dev-other', devices, CLOUD)).toEqual({ kind: 'computer', deviceId: 'dev-other', thisDevice: false, label: '家里的 iMac', online: false, known: true })
  })

  it('设备表里找不到那台:如实说不知道它在哪(known=false),❌ 当成这台', () => {
    expect(assistantHomePlace('dev-gone', devices, CLOUD)).toMatchObject({ kind: 'computer', thisDevice: false, known: false })
  })

  it('还不知道它住哪 = null', () => {
    expect(assistantHomePlace(null, devices, CLOUD)).toBeNull()
  })
})
