import { useCallback, useEffect, useState } from 'react'
import { platform } from '../platform'
import type { SystemPermission, SystemPermissionState } from '../platform/types'

/**
 * 手机「我的 → 权限」页的模型(product spec)。参照 rsend 的权限面板取三条:
 * 状态以系统为准、每一行都点得动、按「缺了的后果」分开处理 —— 前两条落在这里,第三条落在各自的动作上。
 */

/**
 * 每一项权限长什么样(标题 + 一句「用来……」)。**这里不决定列哪几行** ——
 * 列哪几行是 `platform.systemPermissions` 说的(product spec),
 * 这份只是目录:宿主报了哪一项,就到这儿取它的文案。
 */
export const SYSTEM_PERMISSION_ROWS: ReadonlyArray<{
  permission: SystemPermission
  labelKey: string
  /** 一句「用来……」:说用户认得出的功能,不说权限名。 */
  purposeKey: string
}> = [
  {
    permission: 'notifications',
    labelKey: 'settings.permissions.notifications',
    purposeKey: 'settings.permissions.notificationsPurpose',
  },
  {
    // 它不是安卓意义上的「运行时权限」,但在这一页上是同一件事:系统让不让咕咕做这件事,
    // 用户点一下就能改。少了它,部分厂商的系统在息屏后照样掐掉连接,提醒还是收不到。
    permission: 'batteryOptimization',
    labelKey: 'settings.permissions.batteryOptimization',
    purposeKey: 'settings.permissions.batteryOptimizationPurpose',
  },
  {
    permission: 'camera',
    labelKey: 'settings.permissions.camera',
    purposeKey: 'settings.permissions.cameraPurpose',
  },
  {
    permission: 'fileAccess',
    labelKey: 'settings.permissions.fileAccess',
    purposeKey: 'settings.permissions.fileAccessPurpose',
  },
]

/** 宿主报的清单,已按目录顺序取好文案。页面直接渲染它。 */
export function systemPermissionRows(): typeof SYSTEM_PERMISSION_ROWS {
  return SYSTEM_PERMISSION_ROWS.filter((row) => platform.systemPermissions.includes(row.permission))
}

/**
 * 点一行该做什么:系统还肯弹框就弹;不肯弹了(blocked),或者已经开着(想关的人只能去系统设置关),
 * 就直达系统设置。❌ 第三种「什么也不做」—— 那就是 rsend 被拒两次后变成死按钮的那一格。
 */
export function systemPermissionAction(state: SystemPermissionState): 'request' | 'open-settings' {
  return state === 'prompt' ? 'request' : 'open-settings'
}

export type SystemPermissionStates = Partial<Record<SystemPermission, SystemPermissionState>>

/**
 * 读系统真值:挂上时读一次,App 每次回到前台再读 —— 用户从系统设置改完回来,这里立刻是新的。
 * ❌ 缓存 / 持久化:显示的永远是刚问过系统的那一份,否则就会「界面说开了、其实没开」。
 * 没有 `systemPermissions` 能力位的宿主上什么都不读,`states` 恒为空。
 */
export function useSystemPermissionStates(permissions: readonly SystemPermission[]): {
  states: SystemPermissionStates
  refresh: () => Promise<void>
  failed: boolean
} {
  // 只读宿主报得出的那几项 —— 调用方问了别的(例如「通用 → 通知」在桌面问通知),
  // 读不到就是读不到,❌ 不去试一把再吞掉异常。
  const key = permissions.filter((permission) => platform.systemPermissions.includes(permission)).join(',')
  const enabled = key !== ''
  const [states, setStates] = useState<SystemPermissionStates>({})
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(async () => {
    if (!enabled || key === '') return
    try {
      const wanted = key.split(',') as SystemPermission[]
      const entries = await Promise.all(
        wanted.map(async (permission) => [permission, await platform.checkSystemPermission(permission)] as const),
      )
      setStates(Object.fromEntries(entries))
      setFailed(false)
    } catch {
      // 读不到就明说读不到(调用方渲染提示),❌ 留着上一次的值冒充当下。
      setStates({})
      setFailed(true)
    }
  }, [enabled, key])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    return platform.subscribeAppForeground(() => { void refresh() }, () => setFailed(true))
  }, [enabled, refresh])

  return { states, refresh, failed }
}
