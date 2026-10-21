// #7199「设置 → 设备 → 这台电脑能做的事」渲染层 ↔ 主进程的契约,只此一份。
//
// 授权只存在这台电脑上(主进程),❌ 渲染层自己记;页面每次打开都向主进程要一份快照,变了主进程推 changed。
// 列表(已授权 / 可用)→ 点一行进详情(连接 / 断开、状态、连接时间、它能做的每个动作各一个开关);「全部拒绝」一键全停。

export const DEVICE_ACTIONS_CHANNELS = {
  /** 这台电脑能做的事的快照(invoke,回 DeviceActionsState)。 */
  state: 'device-actions:state',
  /** 连上一组(invoke,组 id → DeviceActionsConnectResult):先碰一下系统能力,第一次会弹系统的授权框。 */
  connect: 'device-actions:connect',
  /** 断开一组(invoke,组 id)。立刻生效:正在执行的调用在下一次报进度 / 交结果前被拦下。 */
  disconnect: 'device-actions:disconnect',
  /** 单独关 / 开一个动作(invoke,{ action, enabled })。只能在连上了的组里关,❌ 越过分组打开。 */
  setActionEnabled: 'device-actions:set-action-enabled',
  /** 「全部拒绝」(invoke,boolean)。 */
  setDenyAll: 'device-actions:set-deny-all',
  /** 清掉逐个动作的关闭(invoke)。 */
  resetOverrides: 'device-actions:reset-overrides',
  /** 打开系统设置的对应面板(invoke,x-apple.systempreferences:… / ms-settings:…)。 */
  openSystemSettings: 'device-actions:open-system-settings',
  /** 主进程 → 渲染层:授权或最近调用变了(event,不带内容,收到再要一次 state)。 */
  changed: 'device-actions:changed',
} as const

export interface DeviceActionsActionView {
  name: string
  title: string
  titleEn: string
  /** 给 agent 看的英文说明(详情页里折叠显示)。 */
  description: string
  risk: 'low' | 'medium' | 'high'
  confirm: 'never' | 'always' | 'on_conflict'
  /** 没被单独关掉。 */
  enabled: boolean
  /** 这台电脑做不了它时的原因(缺组件 / 缺工具);做得了就没有这个字段。 */
  unsupported?: string
}

export interface DeviceActionsGroupView {
  id: string
  section?: 'files'
  connected: boolean
  /** 连上的时刻(ISO)。 */
  connectedAt?: string
  /** 现在为什么不能用:原生组件不在(unsupported),或上一次碰到系统权限没给(os_permission)。 */
  blocked: { reason: 'unsupported' | 'os_permission'; message: string } | null
  /** 系统设置里对应的那一页。 */
  settingsUrl?: string
  /** 那个 App 自己的图标(data URL;没有就用通用图标)。 */
  icon?: string
  actions: DeviceActionsActionView[]
}

export interface DeviceActionsRecentCall {
  callId: string
  action: string
  title: string
  titleEn: string
  callerName?: string
  startedAt: string
  finishedAt?: string
  ok?: boolean
  code?: string
  message?: string
}

export interface DeviceActionsState {
  /** 这台电脑支不支持被调用。 */
  supported: boolean
  platform: string
  denyAll: boolean
  groups: DeviceActionsGroupView[]
  /**
   * 开关在一个 App 上的分组(#7317:电脑控制 ↔ Computer Use):不在上面的列表里(❌ 两个开关),由那个 App 的页面办系统授权;
   * `connected` = 那个 App 开着。
   */
  managed?: Array<DeviceActionsGroupView & { app: string }>
  recent: DeviceActionsRecentCall[]
}

export type DeviceActionsConnectResult =
  | { ok: true }
  | {
      ok: false
      code: string
      message: string
      settingsUrl?: string
      /** 咕咕 opened `settingsUrl` itself (the page of the first permission still missing). */
      openedSettings?: true
      /** macOS applies it only after 咕咕 restarts (Screen Recording): offer the restart. */
      restart?: true
    }
