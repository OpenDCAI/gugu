/**
 * #7199 这台电脑上「哪几组动作连上了」:只存在本机(`<userData>/device-action-grants.json`),只能在这台电脑的
 * 「设置 → 设备 → 这台电脑能做的事」里改 —— 云端改不了它,这是授权的意义。默认全关。
 * 文件:四个固定的根(桌面 / 文稿 / 下载 / 其他位置)各是一组(`files.desktop` …),❌ 任选文件夹。
 * 「最近调用」只留在内存里(给人看这台电脑最近被调用过什么),❌ 落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DeviceActionCallRecord } from '@gugu/core/cloud/deviceActionHost'

export interface DeviceActionGrants {
  /** 连上了的组(`calendar`、`files.desktop`……)。 */
  groups: Record<string, boolean>
  /** 每组连上的时刻(ISO;设置页「连接时间」)。 */
  connectedAt: Record<string, string>
  /** 连上了的组里,用户单独关掉的动作(「工具权限」:逐个工具关;只能关,❌ 越过分组打开)。 */
  deniedActions: string[]
  /** 「全部拒绝」:一个都不让调,分组与单个开关都保留,关掉它就恢复原样。 */
  denyAll: boolean
}

export interface DeviceActionGrantsStore {
  read(): DeviceActionGrants
  setGroup(group: string, enabled: boolean): DeviceActionGrants
  setActionEnabled(action: string, enabled: boolean): DeviceActionGrants
  setDenyAll(on: boolean): DeviceActionGrants
  /** 清掉逐个工具的关闭(回到「按分组」)。 */
  resetActionOverrides(): DeviceActionGrants
  recent(): DeviceActionCallRecord[]
  record(entry: DeviceActionCallRecord): void
  /** `grants` = 授权变了(要重新登记);`recent` = 只是多了一条最近调用。 */
  onChange(listener: (kind: 'grants' | 'recent') => void): () => void
}

const RECENT_LIMIT = 30

const EMPTY: DeviceActionGrants = { groups: {}, connectedAt: {}, deniedActions: [], denyAll: false }

function parse(text: string): DeviceActionGrants {
  const raw = JSON.parse(text) as { groups?: unknown; connectedAt?: unknown; deniedActions?: unknown; denyAll?: unknown }
  const groups: Record<string, boolean> = {}
  if (raw.groups && typeof raw.groups === 'object') {
    for (const [key, value] of Object.entries(raw.groups as Record<string, unknown>)) {
      if (value === true) groups[key] = true
    }
  }
  const deniedActions = Array.isArray(raw.deniedActions) ? raw.deniedActions.filter((a): a is string => typeof a === 'string') : []
  const connectedAt: Record<string, string> = {}
  if (raw.connectedAt && typeof raw.connectedAt === 'object') {
    for (const [key, value] of Object.entries(raw.connectedAt as Record<string, unknown>)) {
      if (groups[key] && typeof value === 'string') connectedAt[key] = value
    }
  }
  return { groups, connectedAt, deniedActions: [...new Set(deniedActions)], denyAll: raw.denyAll === true }
}

export function createDeviceActionGrantsStore(file: string): DeviceActionGrantsStore {
  const listeners = new Set<(kind: 'grants' | 'recent') => void>()
  let cache: DeviceActionGrants | null = null
  const recent: DeviceActionCallRecord[] = []
  const notify = (kind: 'grants' | 'recent') => {
    for (const listener of listeners) {
      try {
        listener(kind)
      } catch {
        // 一个监听者坏了不影响别的
      }
    }
  }
  const read = (): DeviceActionGrants => {
    if (cache) return cache
    try {
      cache = parse(fs.readFileSync(file, 'utf8'))
    } catch {
      cache = EMPTY
    }
    return cache
  }
  const save = (next: DeviceActionGrants): DeviceActionGrants => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(tmp, file)
    cache = next
    notify('grants')
    return next
  }
  return {
    read,
    setGroup(group, enabled) {
      const current = read()
      const groups = { ...current.groups }
      const connectedAt = { ...current.connectedAt }
      if (enabled) {
        if (!groups[group]) connectedAt[group] = new Date().toISOString()
        groups[group] = true
      } else {
        delete groups[group]
        delete connectedAt[group]
      }
      return save({ ...current, groups, connectedAt })
    },
    setActionEnabled(action, enabled) {
      const current = read()
      const denied = new Set(current.deniedActions)
      if (enabled) denied.delete(action)
      else denied.add(action)
      return save({ ...current, deniedActions: [...denied].sort() })
    },
    setDenyAll(on) {
      return save({ ...read(), denyAll: on })
    },
    resetActionOverrides() {
      return save({ ...read(), deniedActions: [] })
    },
    recent: () => [...recent],
    record(entry) {
      const index = recent.findIndex((r) => r.callId === entry.callId)
      if (index >= 0) recent[index] = { ...recent[index], ...entry }
      else {
        recent.unshift(entry)
        if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT
      }
      notify('recent')
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function defaultDeviceActionGrantsFile(userData: string): string {
  return path.join(userData, 'device-action-grants.json')
}
