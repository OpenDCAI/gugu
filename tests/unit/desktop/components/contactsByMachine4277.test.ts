import { describe, expect, it } from 'vitest'
import { partitionContactsByDevice } from '../../../../apps/desktop/src/components/contacts/contactsByDevice'
import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
// #4277 段按电脑归并:设备 id 由(机器, 账号, tier)派生(#523),同一台电脑上两个 build 是两条设备行。
// 真机:「本机」与「apple-macbook-pro gugu」并列 —— 同一台 Mac 显示成两段,owner 定为 bug(三句模型「设备是电脑」)。
const device = (device_id: string, label: string, extra: Partial<Device> = {}): Device => ({
  device_id, label, hostname: label, platform: 'darwin', status: 'online', last_seen_at: '', is_online: true,
  capabilities: { terminals: [], runtimes: [] }, ...extra,
})
const agent = (id: string, device_id: string | null): ContactUser =>
  ({ id, type: 'agent', display_name: id, avatar: null, device_id }) as unknown as ContactUser
const MACHINE = '9333E114-8974-5D93-9CE6-D38967B03F73'
const MBP_DEV = device('dev-4969', 'apple-macbook-pro', { is_current_device: true, machine_id: MACHINE })
const MBP_PROD = device('dev-prod', 'apple-macbook-pro gugu', { machine_id: MACHINE })
const STUDIO_A = device('dev-studio-a', 'Mac Studio', { machine_id: 'STUDIO-MACHINE' })
const STUDIO_B = device('dev-studio-b', 'Mac Studio', { machine_id: 'STUDIO-MACHINE', is_online: false })
describe('partitionContactsByDevice(#4277 一台电脑一段)', () => {
  it('本机的另一条设备行(另一个 build)归「本机」,❌ 另起一段', () => {
    const p = partitionContactsByDevice([agent('a-dev', 'dev-4969'), agent('a-prod', 'dev-prod')], [], [MBP_DEV, MBP_PROD])
    expect(p.sections.map((s) => [s.key, s.agents.map((a) => a.id)])).toEqual([['local', ['a-dev', 'a-prod']]])
  })
  it('别的电脑上的两条设备行也归并成一段,名字取 store 里排前的那条', () => {
    const p = partitionContactsByDevice(
      [agent('a-sa', 'dev-studio-a'), agent('a-sb', 'dev-studio-b')],
      [],
      [MBP_DEV, STUDIO_A, STUDIO_B],
    )
    expect(p.sections.map((s) => [s.key, s.scope, s.agents.map((a) => a.id)])).toEqual([
      ['local', 'local', []],
      ['STUDIO-MACHINE', 'device', ['a-sa', 'a-sb']],
    ])
    expect(p.sections[1]!.displayLabel, '同机两行不算重名,不补 id').toBe('Mac Studio')
    expect(p.sections[1]!.online, '在线态取 store 里排前的那条').toBe(true)
  })
  it('对照:没有 machine_id 的老行仍按 device_id 各成一段 —— 证明归并是 machine_id 在起作用', () => {
    const p = partitionContactsByDevice(
      [agent('a-x', 'dev-x'), agent('a-y', 'dev-y')],
      [],
      [MBP_DEV, device('dev-x', 'X'), device('dev-y', 'Y')],
    )
    expect(p.sections.map((s) => s.key)).toEqual(['local', 'dev-x', 'dev-y'])
  })
})
