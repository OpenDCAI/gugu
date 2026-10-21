import { useEffect, useState } from 'react'
import type { SshLinkFailure } from '../lib/sshLink'
import { currentSshMachineIds, subscribeSshLinkProblems, subscribeSshMachineIds, subscribeSshUpgrades } from '../lib/sshLinkChannel'

/** 每台远程 SSH 机器的设备连接此刻的问题(没有 = 连着或还没连过)。 */
export function useSshLinkProblems(): ReadonlyMap<string, SshLinkFailure> {
  const [problems, setProblems] = useState<ReadonlyMap<string, SshLinkFailure>>(() => new Map())
  useEffect(() => subscribeSshLinkProblems(setProblems), [])
  return problems
}

/** 正在替它升级的远程 SSH 机器:deviceId → 进度百分比(不知道总量 = null)。 */
export function useSshUpgrades(): ReadonlyMap<string, number | null> {
  const [upgrades, setUpgrades] = useState<ReadonlyMap<string, number | null>>(() => new Map())
  useEffect(() => subscribeSshUpgrades(setUpgrades), [])
  return upgrades
}

/** 这台电脑记着怎么 SSH 过去的远程 SSH 机器(装上 / 移除一台跟着变)。 */
export function useSshMachineIds(): ReadonlySet<string> {
  const [ids, setIds] = useState(() => currentSshMachineIds())
  useEffect(() => subscribeSshMachineIds(setIds), [])
  return ids
}
