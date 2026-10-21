import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudComputerFailureKind, type CloudComputerFailureKind } from '@gugu/core/cloud/cloudComputer'
import type { Device } from '@gugu/core/shared/types/chat'
import { refreshCloudComputer, wakeCloudComputer } from '../lib/cloudComputerStore'
import { rendererLogger } from '../lib/log'

const log = rendererLogger('agent-watch/cloud-computer')

/** 叫醒没成是哪一类(给人看的只有这几类,原文进日志)。 */
export type CloudComputerWakeIssue = { kind: CloudComputerFailureKind }

/**
 * #7199 打开 / 在它上面新建会话的那一页挂上时,这台是睡着的云电脑就叫醒它(规定草稿 cloud-computer:
 * 「你在任何一端打开它上面的会话」是叫醒它的三件事之一)。醒的过程由设备行上的 `cloud_computer` 说(正在唤醒 → 运行中),
 * 这里交出叫醒没成是哪一类(积分用完 / 连不上 / 那边出了问题…,❌ 一直「正在唤醒」)和一个「重试」:没叫起来时由人
 * 再叫一次(owner 10-17:要读它家里的东西由系统叫起来,❌ 让人先按「叫醒它」;真没叫起来才说原因、给重试)。
 * `dropped` = 这一页开着时它醒过(看到过正在唤醒 / 醒着)、又被收回了:页面说「连接断了」+ 重新连接,❌ 一直转
 * 「正在连接」,也 ❌ 自己再叫(那样页面开着它就永远收不回)。刚叫醒成功、管家那一格还没翻过来的那一下不算断。
 */
export function useCloudComputerWake(device: Pick<Device, 'device_id' | 'cloud_computer'> | null): { issue: CloudComputerWakeIssue | null; dropped: boolean; retry: () => void } {
  const [issue, setIssue] = useState<{ deviceId: string; issue: CloudComputerWakeIssue } | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const deviceId = device?.device_id ?? null
  const presence = device?.cloud_computer ?? null
  // 每打开一次这一页只叫一次:开着时它又睡着了 ❌ 再叫(那样它睡不着、一直扣积分)。
  const seenFor = useRef<string | null>(null)
  // 上一次叫醒之后看到过它起来(正在唤醒 / 醒着)没有:没看到过就落回 asleep 的不是「断了」,是还没翻过来。
  const upSinceWake = useRef(false)
  const mounted = useRef(true)
  // setup 里置回「挂着」:StrictMode(产品入口包着它)开发模式下 setup → cleanup → setup,只在 cleanup 里置 false
  // 会让它一直是 false,叫醒没成的原因、「还在叫」都再也落不到页面上。
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (presence === 'waking' || presence === 'awake') upSinceWake.current = true
  }, [presence])
  const wakeDevice = useCallback((target: string) => {
    setIssue(null)
    setInFlight(true)
    upSinceWake.current = false
    return wakeCloudComputer()
      .catch((error: unknown) => {
        if (!mounted.current) return
        log.warn({ err: String((error as Error)?.message ?? error) }, 'wake cloud computer failed')
        setIssue({ deviceId: target, issue: { kind: cloudComputerFailureKind(error) } })
      })
      .finally(() => {
        if (mounted.current) setInFlight(false)
      })
  }, [])
  useEffect(() => {
    if (!deviceId || seenFor.current === deviceId) return
    seenFor.current = deviceId
    if (presence !== 'asleep' && presence !== 'awake') return
    const wake = () => wakeDevice(deviceId)
    if (presence === 'asleep') {
      void wake()
      return
    }
    // 设备表里的「醒着」可能还是睡下之前的(库里那一行要等心跳超时才翻):现问一次管家,真睡着了再叫。
    // 问不到 ❌ 说「没能唤醒」(没叫过),照醒着处理。
    void refreshCloudComputer()
      .catch(() => null)
      .then((fresh) => {
        if (mounted.current && fresh?.deviceId === deviceId && fresh.state === 'asleep') return wake()
      })
  }, [deviceId, presence, wakeDevice])
  const retry = useCallback(() => {
    if (deviceId) void wakeDevice(deviceId)
  }, [deviceId, wakeDevice])
  const shownIssue = issue && issue.deviceId === device?.device_id ? issue.issue : null
  const dropped =
    !shownIssue && !inFlight && presence === 'asleep' && deviceId !== null && seenFor.current === deviceId && upSinceWake.current
  return { issue: shownIssue, dropped, retry }
}
