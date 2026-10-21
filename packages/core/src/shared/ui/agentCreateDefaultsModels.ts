import type { Device } from '../types/chat'
import { deviceAcceptsWork } from '../../cloud/cloudComputer'

// @@@per-user-create-defaults (#2525) — 「设备/项目默认值记忆」的纯模型。
// 规范正文（#2505 product spec §设备与项目默认值）只说「记住最近一次选择」；#2505 的
// 视觉稿画的是跨 Desktop/Mobile 共享的记忆。冲突处按视觉稿：记忆是 **per-user**（跟着账号走，落
// identity.user_settings），不是本机 localStorage —— 同一个人在两种客户端形态上是同一个 user，
// 本机存储会让他在另一端把已经选过的设备/项目再选一遍，而那正是「记住」要消除的动作。
// 决策记录见 https://github.com/nmhjklnm/gugu/issues/2525#issuecomment-5139078981

/** `identity.user_settings` scope='user' 里本功能独占的键。 */
export const AGENT_CREATE_DEFAULTS_KEY = 'agent_create'

export interface AgentCreateDefaults {
  /** 用户**主动**选过的设备。null = 从未选过 → 走「首次默认本机」。 */
  deviceId: string | null
  /** deviceId → 该设备上最近一次选的项目。项目默认「沿用所选设备最近使用的项目」，故按设备分桶。 */
  projectByDevice: Record<string, string>
}

export const EMPTY_AGENT_CREATE_DEFAULTS: AgentCreateDefaults = Object.freeze({
  deviceId: null,
  projectByDevice: Object.freeze({}) as Record<string, string>,
})

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * 解析 user_settings.config 里的本功能子对象。存储格式脏（旧版本/别的客户端写的）不是错误——
 * 这是一份 UI 偏好，读不懂的字段丢掉即可；❌ 但也不允许"猜"出一个用户没选过的设备来。
 */
export function parseAgentCreateDefaults(config: unknown): AgentCreateDefaults {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return EMPTY_AGENT_CREATE_DEFAULTS
  const raw = (config as Record<string, unknown>)[AGENT_CREATE_DEFAULTS_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_AGENT_CREATE_DEFAULTS
  const row = raw as Record<string, unknown>
  const projectByDevice: Record<string, string> = {}
  const projects = row.project_by_device
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [deviceId, projectId] of Object.entries(projects as Record<string, unknown>)) {
      const id = readString(projectId)
      if (deviceId && id) projectByDevice[deviceId] = id
    }
  }
  return { deviceId: readString(row.device_id), projectByDevice }
}

function serialize(defaults: AgentCreateDefaults): Record<string, unknown> {
  return {
    [AGENT_CREATE_DEFAULTS_KEY]: {
      device_id: defaults.deviceId,
      project_by_device: defaults.projectByDevice,
    },
  }
}

/** 记住设备的最近一次选择。「再次切换后覆盖旧默认值」= 直接改写，不叠历史。 */
export function mergeAgentCreateDeviceChoice(
  config: Record<string, unknown>,
  deviceId: string,
): Record<string, unknown> {
  const current = parseAgentCreateDefaults(config)
  return { ...config, ...serialize({ ...current, deviceId }) }
}

/** 记住某设备下的项目选择；null = 用户显式选了「不使用项目」，该设备的记忆被清掉而不是留着。 */
export function mergeAgentCreateProjectChoice(
  config: Record<string, unknown>,
  deviceId: string,
  projectId: string | null,
): Record<string, unknown> {
  const current = parseAgentCreateDefaults(config)
  const projectByDevice = { ...current.projectByDevice }
  if (projectId) projectByDevice[deviceId] = projectId
  else delete projectByDevice[deviceId]
  return { ...config, ...serialize({ ...current, projectByDevice }) }
}

// ── 设备解析 ──────────────────────────────────────────────────────────────────

export type AgentCreateDeviceResolution =
  /** 可创建：设备在线且就是本机。 */
  | { kind: 'ready'; device: Device }
  /**
   * 设备真实存在、真实状态照实显示，但**不可提交**：
   *  - `offline` 记住的设备离线（规范：仍显示该设备和真实状态，由用户明确切换；离线设备不可提交）
   *  - `remote`  在线但不是本机 —— 跨设备创建的数据面属于 #2525 决策 2 那条车道，今天没接线。
   *              ❌ 绝不偷偷改在本机建：那既是静默回落，也是假控件。
   */
  | { kind: 'blocked'; device: Device; reason: 'offline' | 'remote' }
  /**
   * 记住的设备在这里选不到了（已从名下删除，或是只在别的电脑上列的远程 SSH 机器）—— 就是「还没选」：
   * 选择器空着等用户挑，❌ 报错（那不是用户造成的状态），❌ 静默换一台。
   */
  | { kind: 'missing'; deviceId: string }
  /** 名下一台设备都没有（未注册/尚未加载完）。 */
  | { kind: 'none' }

/**
 * 规范 §设备与项目默认值 的前三条，全在这里：
 *  ① 用户第一次创建时，设备默认本机。（`defaults.deviceId === null` → 取 is_current_device）
 *  ② 用户主动选择设备后记住最近一次选择；下次创建默认使用该设备。
 *  ③ 已记忆设备离线或不可用时**仍显示该设备和真实状态**，由用户明确切换；不得静默回落到本机或其他设备。
 *
 * ③ 的实现要点是这个函数**没有** fallback 分支：记忆命中一台离线设备就返回那台离线设备，而不是
 * 返回本机。回落发生在渲染层就已经晚了——所以这里根本不给它回落的机会。
 */
export function resolveAgentCreateDevice(
  defaults: AgentCreateDefaults,
  devices: Device[],
): AgentCreateDeviceResolution {
  if (devices.length === 0) return { kind: 'none' }
  if (defaults.deviceId) {
    const remembered = devices.find((device) => device.device_id === defaults.deviceId)
    if (!remembered) return { kind: 'missing', deviceId: defaults.deviceId }
    return classifyDevice(remembered)
  }
  const local = devices.find((device) => device.is_current_device)
  if (!local) return { kind: 'none' }
  return classifyDevice(local)
}

function classifyDevice(device: Device): AgentCreateDeviceResolution {
  // #7199 休眠中的云电脑 ≠ 离线:照常能选,在它上面建会先叫醒它。
  if (!deviceAcceptsWork(device)) return { kind: 'blocked', device, reason: 'offline' }
  if (!device.is_current_device) return { kind: 'blocked', device, reason: 'remote' }
  return { kind: 'ready', device }
}

/** 面向用户的阻塞原因。空 = 可提交。文案必须点名那台设备并给出可操作的下一步，❌ 不许只说「失败」。 */
export function agentCreateDeviceBlockMessage(
  resolution: AgentCreateDeviceResolution,
): string | null {
  switch (resolution.kind) {
    case 'ready':
      return null
    case 'blocked':
      return resolution.reason === 'offline'
        ? `设备「${resolution.device.label}」当前离线，无法在它上面创建。请等它上线，或在上方改选一台在线设备。`
        : `设备「${resolution.device.label}」是远端设备，跨设备创建尚未接线（见 #2525 决策 2）。请改选本机。`
    case 'missing':
      return null
    case 'none':
      return '没有可用设备：本机尚未注册为咕咕设备。'
  }
}

// ── 项目解析 ──────────────────────────────────────────────────────────────────

/**
 * 规范：项目默认沿用所选设备最近使用的项目；没有合适项目时显示「未选择项目」；项目列表只展示所选
 * 设备可用的项目，切换设备导致当前项目不可用时清空项目。
 *
 * 记忆里的 id 不在可用列表里 → null（=「未选择项目」），❌ 不回落到列表第一个。
 */
export function resolveAgentCreateProject(
  defaults: AgentCreateDefaults,
  deviceId: string | null,
  availableProjectIds: readonly string[],
): string | null {
  if (!deviceId) return null
  const remembered = defaults.projectByDevice[deviceId]
  if (!remembered) return null
  return availableProjectIds.includes(remembered) ? remembered : null
}
