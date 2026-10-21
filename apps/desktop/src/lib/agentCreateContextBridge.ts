// @@@gugu-sessionpage-create-context (#2525) — 共享 Session Composer 的「创建上下文」适配边界。
//
// 对话页创建草稿渲染的是会话页子应用（shadow root + 它自己的 React 根），gugu 的 React context
// 跨不过去。#2549 已经确立了这条边界的形状：`window.__EMDASH_*` 全局函数，双向、无新 IPC 桥。
// 这里沿用它，只是方向反过来（gugu → 会话页提供数据 + 接收选择）。
//
// 分工按"谁真正持有数据"切，不来回搬：
//   gugu  持有设备维度（identity.gugu_devices 的真实在线状态）与 per-user 记忆的读写/解析；
//   会话页持有项目列表（它自己的 mobx project store）与托盘 UI。
// 项目**规则**仍只有一份（core 的 resolveAgentCreateProject）：会话页把它当前可用的项目 id 上报，
// gugu 解析后把结果放回快照。❌ 不把"记忆命中就用、否则未选择"这条规则在会话页侧再写一遍。

import type { CloudComputerPresence } from '@gugu/core/shared/types/deviceHost'

export interface CreateContextDevice {
  id: string
  label: string
  isLocal: boolean
  isOnline: boolean
  /** 那台机器报的系统;选择器标一句「Linux」「macOS」。 */
  platform?: string | null
  /** 最后一次心跳(ISO);离线的写「上次在线 X」。 */
  lastSeenAt?: string | null
  /** 电脑还是服务器(咕咕 server);机器选择器据此画种类图标。缺席 = 电脑。 */
  kind?: 'computer' | 'server'
  /** #7199 这一台是云电脑时此刻的样子;休眠中 / 正在唤醒照常可选(选了先叫醒),❌ 灰掉。 */
  cloudComputer?: CloudComputerPresence
}

export interface CreateContextSnapshot {
  /** per-user 默认值是否已读回。false 时挡住提交，❌ 不先采用一个可能是错的默认值。 */
  ready: boolean
  devices: CreateContextDevice[]
  selectedDeviceId: string | null
  /**
   * 已解析的项目选择（记忆命中所选设备的可用列表才有值），null = 未选择项目。
   * 会话页侧据此渲染项目名并把它交给 NewSessionComposer。
   */
  selectedProjectId: string | null
  /**
   * 所选设备的项目列表是否可用。远端设备今天读不到它的会话页项目 → false，
   * 会话页侧显示显式空态，❌ 绝不把本机项目列在远端设备下面。
   */
  projectsAvailable: boolean
  /** 非 null = 不可提交，原样显示给用户（离线 / 远端未接线 / 设备已删 / 读写失败）。 */
  blockMessage: string | null
  /**
   * 从群成员里点的「新建 Agent」:建出来的 agent 一出生就进这个群(createSession 的 birthChatId)。
   * 只活在这一次草稿里,❌ 不进 per-user 记忆。null = 不进群。
   */
  birthGroup: CreateContextBirthGroup | null
}

export interface CreateContextBirthGroup {
  chatId: string
  name: string
}

export interface CreateContextBridge {
  getSnapshot(): CreateContextSnapshot
  subscribe(listener: () => void): () => void
  selectDevice(deviceId: string): void
  selectProject(projectId: string | null): void
  /** 会话页侧把它当前可用的项目 id 上报上来，供 gugu 解析记忆。 */
  reportAvailableProjects(projectIds: string[]): void
  /** 托盘上去掉那个群:这次建的 agent 不进群。 */
  clearBirthGroup(): void
}

export const CREATE_CONTEXT_BRIDGE_KEY = '__GUGU_CREATE_CONTEXT__' as const

export type CreateContextBridgeWindow = Window & {
  [CREATE_CONTEXT_BRIDGE_KEY]?: CreateContextBridge
}
