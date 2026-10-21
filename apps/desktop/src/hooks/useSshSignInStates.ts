import { useEffect, useMemo, useRef, useState } from 'react'
import type { Device } from '@gugu/core/shared/types/chat'
import { SERVER_SSH_MACHINES_CHANNELS, type SshSignInState } from '../lib/serverSshMachines'
import { desktopIpc } from '../platform/desktopIpc'

/**
 * #6264 哪几台要问「这个账号在那台机器上还登着吗」:离线的、这台桌面记着怎么 SSH 过去的。
 * 每台一个键(设备 id + 上次在线时间):同一段离线只问一次,它回来又走了才再问。纯函数,单测钉住。
 */
export function signInProbeKeys(devices: readonly Device[], sshAddress: (deviceId: string) => string | null): Map<string, string> {
  const keys = new Map<string, string>()
  for (const device of devices) {
    if (device.is_online || device.is_current_device || !sshAddress(device.device_id)) continue
    keys.set(device.device_id, `${device.device_id}@${device.last_seen_at ?? ''}`)
  }
  return keys
}

/**
 * 离线的 SSH 机器各问一次(经 SSH 读那台机器的 `gugu-server status --json`),答案决定设备行上写「离线」
 * 还是「登录已失效 · 重新登录」。触发:打开「设置 → 设备」、或某台刚变成离线;❌ 轮询。
 * 每问一次 = 一次 ssh(复用终端的连接时几十毫秒;连不上 8 秒超时)。
 */
export function useSshSignInStates(
  devices: readonly Device[],
  sshAddress: (deviceId: string) => string | null,
): ReadonlyMap<string, SshSignInState> {
  const keys = useMemo(() => signInProbeKeys(devices, sshAddress), [devices, sshAddress])
  // 设备列表每次心跳都会换一个新数组;按「要问的那一组」的内容触发,❌ 按数组引用(那会每 30 秒问一轮)。
  const signature = [...keys.values()].sort().join('|')
  const [answers, setAnswers] = useState<ReadonlyMap<string, { key: string; state: SshSignInState }>>(() => new Map())
  const asked = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    const electron = desktopIpc()
    if (!electron || !signature) return
    for (const key of signature.split('|')) {
      if (asked.current.has(key)) continue
      asked.current.add(key)
      const deviceId = key.slice(0, key.indexOf('@'))
      void electron.invoke(SERVER_SSH_MACHINES_CHANNELS.signInState, deviceId).then(
        (value) => {
          if (!mounted.current) return
          const state = (value ?? { state: 'unknown' }) as SshSignInState
          setAnswers((prev) => new Map(prev).set(deviceId, { key, state }))
        },
        () => undefined,
      )
    }
  }, [signature])

  return useMemo(() => {
    const out = new Map<string, SshSignInState>()
    for (const [deviceId, key] of keys) {
      const answer = answers.get(deviceId)
      if (answer?.key === key) out.set(deviceId, answer.state)
    }
    return out
  }, [keys, answers])
}
