/**
 * #6264 渲染层这一侧:主进程替远程 SSH 的机器升级时报来的每一步,落成这台机器设备连接的状况 ——
 * 在升 → 「正在更新」(带进度);升好 → 清掉问题并当场重连(与刚登上同一条路);没升成 → 「版本太旧」。
 */
import { describe, expect, it } from 'vitest'
import {
  applyUpgradeEvent,
  onSshMachineSignedIn,
  subscribeSshLinkProblems,
  subscribeSshUpgrades,
} from '../../../../apps/desktop/src/lib/sshLinkChannel'
import type { SshLinkFailure } from '../../../../apps/desktop/src/lib/sshLink'

describe('替它升级的每一步 → 设备连接的状况', () => {
  it('updating(带进度)→ done:问题清掉、当场重连;failed:停在「版本太旧」', () => {
    let problems: ReadonlyMap<string, SshLinkFailure> = new Map()
    let upgrades: ReadonlyMap<string, number | null> = new Map()
    const reopened: string[] = []
    const offProblems = subscribeSshLinkProblems((next) => (problems = next))
    const offUpgrades = subscribeSshUpgrades((next) => (upgrades = next))
    const offSignedIn = onSshMachineSignedIn((deviceId) => reopened.push(deviceId))

    applyUpgradeEvent({ deviceId: 'd22', phase: 'updating', percent: null })
    expect(problems.get('d22')).toBe('updating')
    expect(upgrades.get('d22')).toBeNull()
    applyUpgradeEvent({ deviceId: 'd22', phase: 'updating', percent: 40 })
    expect(upgrades.get('d22')).toBe(40)

    applyUpgradeEvent({ deviceId: 'd22', phase: 'done' })
    expect(problems.has('d22')).toBe(false)
    expect(upgrades.has('d22')).toBe(false)
    expect(reopened).toEqual(['d22'])

    applyUpgradeEvent({ deviceId: 'd23', phase: 'updating', percent: 10 })
    applyUpgradeEvent({ deviceId: 'd23', phase: 'failed' })
    expect(problems.get('d23')).toBe('outdated')
    expect(upgrades.has('d23')).toBe(false)
    expect(reopened).toEqual(['d22'])

    offProblems()
    offUpgrades()
    offSignedIn()
  })
})
