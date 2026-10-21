/** #6264 别的电脑上移除了远程 SSH 的机器 → 加它的这台电脑下次读到账号设备名单时忘掉它。 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

import { machinesGoneFromAccount, RECONCILE_GRACE_MS, type SshMachine } from '../../../../apps/desktop/electron/server/ssh-machines'

const NOW = Date.parse('2026-09-25T10:00:00Z')
const machine = (deviceId: string, over: Partial<SshMachine> = {}): SshMachine => ({
  deviceId, ownerUserId: 'me', destination: 'alice@h', display: 'alice@h', addedAt: '2026-09-24T00:00:00Z', ...over,
})

describe('对账:账号名下已经没有的机器', () => {
  it('名单里没有 → 忘掉;还在 → 留着', () => {
    const gone = machinesGoneFromAccount([machine('a'), machine('b')], 'me', new Set(['a']), NOW)
    expect(gone.map((m) => m.deviceId)).toEqual(['b'])
  })

  it('刚装上、还在宽限里的不算(它的设备行可能还没落库)', () => {
    const fresh = machine('c', { addedAt: new Date(NOW - RECONCILE_GRACE_MS + 1000).toISOString() })
    expect(machinesGoneFromAccount([fresh], 'me', new Set(), NOW)).toEqual([])
  })

  it('别的账号装上的不碰', () => {
    expect(machinesGoneFromAccount([machine('d', { ownerUserId: 'other' })], 'me', new Set(), NOW)).toEqual([])
  })
})
