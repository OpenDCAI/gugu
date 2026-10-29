import { isImplicitSessionHomeProjectId } from '../shared/sessionProject'
import { normalizeDeviceActionsSummary, type DeviceActionsSummary } from '../shared/deviceActions'
import { parseMachineLimitRefusal, type MachineLimitRefusal } from './machineLimit'
import { isDeviceOnline } from '../shared/enums/deviceModels'
import { parseAgentStatusView } from '../shared/agentStatus'
import type {
  Device,
  DeviceCapabilities,
  DeviceSessionSummary,
  DeviceStatus,
} from '../shared/types/chat'
import type { DeviceServerDisk, DeviceServerRollback, DeviceServerUpdate } from '../shared/types/deviceHost'

type DeviceQueryResult = {
  data: unknown
  error: { message: string } | null
}

export interface DeviceTableClient {
  from(table: 'gugu_devices'): {
    select(columns: string): {
      eq(column: 'user_id', value: string): {
        in(column: 'device_id', values: readonly string[]): {
          order(column: string, options: { ascending: boolean }): PromiseLike<DeviceQueryResult>
        }
        order(column: string, options: { ascending: boolean }): PromiseLike<DeviceQueryResult>
      }
    }
  }
}

// #1749 rename / remove 都走 RPC 一条受控路径。
// rename 必须用 RPC(不是裸 UPDATE label)：设备心跳每 ~30s 全行 upsert 会用 hostname 默认名覆写 label，
// rename_device 同时打 label_customized_at 标记，DB 触发器据此让后续心跳保留自定义名(见迁移)。
export interface DeviceRpcClient {
  rpc(
    fn: 'rename_device' | 'remove_device',
    args: Record<string, unknown>,
  ): PromiseLike<{ error: { message: string } | null }>
}

/** 设备删除被绑定 agent 拦住时的哨兵前缀(DB RAISE 'DEVICE_HAS_AGENTS: N agent(s)…')。 */
export const DEVICE_HAS_AGENTS_PREFIX = 'DEVICE_HAS_AGENTS'

export function isDeviceHasAgentsError(message: string): boolean {
  return message.includes(DEVICE_HAS_AGENTS_PREFIX)
}

/**
 * #6264 这台机器已被账号主人移除(DB RAISE 'DEVICE_REMOVED: …',见迁移 *_device_removal_signs_out_server_6264)。
 * 库对被移除的咕咕 server 的心跳一律回这一句,直到这个账号在那台机器上重新登录。
 */
export const DEVICE_REMOVED_PREFIX = 'DEVICE_REMOVED'

export function isDeviceRemovedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message.includes(DEVICE_REMOVED_PREFIX)
}

export async function renameDevice(
  client: DeviceRpcClient,
  deviceId: string,
  label: string,
): Promise<void> {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('设备名不能为空')
  const { error } = await client.rpc('rename_device', { p_device_id: deviceId, p_label: trimmed })
  if (error) throw new Error(error.message)
}

/** 库替没报名字的设备取的默认名(`Linux 2`、`Mac 1`,见迁移 gugu_devices_default_label)。 */
export function isDerivedDeviceLabel(label: string): boolean {
  return /^(Mac|Linux|Windows|Device) \d+$/.test(label)
}

export interface DeviceLabelClient extends DeviceRpcClient {
  from(table: 'gugu_devices'): {
    select(columns: 'label, label_customized_at'): {
      eq(column: 'device_id', value: string): { maybeSingle(): PromiseLike<DeviceQueryResult> }
    }
  }
}

/**
 * #6264 这台机器早就有设备行、名字还是库取的 `Linux 2`(人没改过),现在有了人给它的名字(SSH 别名)⇒ 换成这个名字。
 * 人改过的、已经不是默认名的一律不动;还没有这一行 ⇒ 不做(第一次心跳自己会带上名字)。
 * @returns 改没改。
 */
export async function adoptDeviceName(client: DeviceLabelClient, deviceId: string, name: string): Promise<boolean> {
  const { data, error } = await client.from('gugu_devices').select('label, label_customized_at').eq('device_id', deviceId).maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as { label?: unknown; label_customized_at?: unknown } | null
  if (!row || row.label_customized_at || typeof row.label !== 'string' || !isDerivedDeviceLabel(row.label)) return false
  await renameDevice(client, deviceId, name)
  return true
}

/**
 * #6264 「远程隧道」那一段就地等新机器时顺带问一句:p_since 之后,这个账号有没有哪台 server 因为机器上限没登上
 * (确认页点「允许」或 server 领取登录结果时被库拒了)。没有 = null。
 */
export interface MachineLimitRefusalRpcClient {
  rpc(fn: 'my_recent_machine_limit_refusal', args: { p_since: string }): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export async function recentMachineLimitRefusal(
  client: MachineLimitRefusalRpcClient,
  sinceIso: string,
): Promise<(MachineLimitRefusal & { hostname: string | null }) | null> {
  const { data, error } = await client.rpc('my_recent_machine_limit_refusal', { p_since: sinceIso })
  if (error) throw new Error(error.message)
  const refusal = parseMachineLimitRefusal(data)
  if (!refusal) return null
  const hostname = (data as { hostname?: unknown }).hostname
  return { ...refusal, hostname: typeof hostname === 'string' && hostname ? hostname : null }
}

export async function removeDevice(
  client: DeviceRpcClient,
  deviceId: string,
  options: { cascade?: boolean } = {},
): Promise<void> {
  const { error } = await client.rpc('remove_device', {
    p_device_id: deviceId,
    p_cascade: options.cascade ?? false,
  })
  if (error) throw new Error(error.message)
}

// @@@1962 只列当前用户自己的设备(user_id = ownerId 显式过滤)。gugu_devices 生产 RLS 虽已 owner-scoped
// (user_id = auth.uid()),但多账号同机的测试路径(service-role / 共享 client)会绕过 RLS → 列表混入他人
// online 设备行,新建 Agent 弹窗把它当「本机·在线」默认选中 → 创建被 RPC 拒(device_id … is not owned by
// current user)。此处加显式 WHERE 护栏,RLS 之外再兜一层,绝不回退到别人的行。ownerId 缺失即报错
// (fail-loud,不做无 owner 作用域的全表列举)。
//
// Action-only phones stay out of run targets. An Android host appears only after its native
// runtime advertises both a host capability and an available harness.
export async function listDevices(
  client: DeviceTableClient,
  ownerId: string,
  options: { includePhones?: boolean; /** Only these rows (a device_changed revision names the one that changed). */ deviceIds?: readonly string[] } = {},
): Promise<Device[]> {
  if (!ownerId) throw new Error('listDevices requires ownerId (refuse to list devices without an owner scope)')
  const owned = client
    .from('gugu_devices')
    .select('device_id, label, hostname, platform, status, last_seen_at, created_at, capabilities:device_list_capabilities, machine_id, tier, session_digest')
    .eq('user_id', ownerId)
  const { data, error } = await (options.deviceIds ? owned.in('device_id', options.deviceIds) : owned)
    .order('last_seen_at', { ascending: false })
  if (error) throw new Error(error.message)

  if (!Array.isArray(data)) throw new Error('Device list response must be an array')
  const devices = data.map((row) => normalizeDeviceRow(row))
  return options.includePhones ? devices : devices.filter(isAgentHostDevice)
}

/** Device kind and host availability are independent: a phone can also host agents. */
export function isPhoneDevice(device: Pick<Device, 'capabilities'>): boolean {
  return device.capabilities.host_kind === 'phone'
}

export function isAgentHostDevice(device: Pick<Device, 'capabilities'>): boolean {
  return !isPhoneDevice(device)
    || (typeof device.capabilities.host_runtime_capability === 'number'
      && device.capabilities.host_runtime_capability > 0 && device.capabilities.runtimes.length > 0)
}

export function normalizeDeviceRow(value: unknown): Device {
  if (!value || typeof value !== 'object') throw new Error('Device row is missing')
  const row = value as Record<string, unknown>
  const status = normalizeDeviceStatus(row.status)
  const device = {
    device_id: requiredText(row.device_id, 'device_id'),
    label: requiredText(row.label, 'label'),
    hostname: requiredText(row.hostname, 'hostname'),
    platform: requiredText(row.platform, 'platform'),
    status,
    last_seen_at: requiredText(row.last_seen_at, 'last_seen_at'),
    capabilities: normalizeDeviceCapabilities(row.capabilities),
    // 老行 / 老测试桩没有这列 ⇒ null(展示层退回按 device_id 归类),❌ 当缺列报错。
    machine_id: typeof row.machine_id === 'string' && row.machine_id ? row.machine_id : null,
    // When this row first appeared (a new install, a new data directory): what tells a machine that replaced another
    // from an old one. Old rows / stubs without it ⇒ absent.
    ...(typeof row.created_at === 'string' && row.created_at ? { created_at: row.created_at } : {}),
    ...(typeof row.tier === 'string' && row.tier ? { tier: row.tier } : {}),
    // 离线时手机拿它显示「这台机器上有哪些会话、卡在哪儿」。同上:老行没有这列 ⇒ 空,
    // ❌ 不报错 —— 迁移铺开之前每一行都没有它。
    session_digest: normalizeSessionDigest(row.session_digest)
  }
  return {
    ...device,
    // @@@5912 在线是库给的结论,不是这里拿时间戳算出来的。last_seen_at 留着只为离线时显示「多久没上线」。
    is_online: isDeviceOnline(device.status)
  }
}

/**
 * 会话摘要:整份不认识就当空，单条缺字段就丢掉那一条。
 *
 * ❌ 不为一行坏数据把整台机器判成读不出来：这一列是**附加**信息，它坏了不该让机器列表也打不开。
 * 但也 ❌ 不给缺字段的条目补默认值冒充完整 —— 那样屏幕上会出现一条没有名字、状态不明的会话，
 * 比不显示更让人困惑。
 */
function digestStatusOf(raw: unknown): Pick<DeviceSessionSummary, 'status'> {
  if (raw === undefined) return {}
  try {
    return { status: parseAgentStatusView(raw) }
  } catch {
    return {}
  }
}

export function normalizeSessionDigest(value: unknown): DeviceSessionSummary[] {
  if (!Array.isArray(value)) return []
  const out: DeviceSessionSummary[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const sessionId = typeof row.conversationId === 'string' ? row.conversationId : ''
    const title = typeof row.title === 'string' ? row.title : ''
    if (!sessionId || !title) continue
    out.push({
      ...(typeof row.nativeUnreadCount === 'number' && Number.isSafeInteger(row.nativeUnreadCount) && row.nativeUnreadCount >= 0 ? { nativeUnreadCount: row.nativeUnreadCount } : {}),
      conversationId: sessionId,
      projectId: typeof row.projectId === 'string' ? row.projectId : '',
      projectName: !isImplicitSessionHomeProjectId(typeof row.projectId === 'string' ? row.projectId : null) && typeof row.projectName === 'string' ? row.projectName : '',
      title,
      harness: typeof row.harness === 'string' ? row.harness : 'unknown',
      agentStatus: typeof row.agentStatus === 'string' ? row.agentStatus : null,
      // 新宿主才带读数;缺席不补(读侧退回 `agentStatus`)。坏的一条丢读数不丢会话:这一列是附加信息。
      ...digestStatusOf(row.status),
      lastInteractedAt: typeof row.lastInteractedAt === 'string' ? row.lastInteractedAt : null,
      supported: row.supported !== false,
      /*
       * 这三项**有才带**。老宿主写的摘要里没有这几个键,那时的事实是「不知道」——
       * 展开成 `false` / `null` 就是在替一台我们读不到的机器打包票(一条置顶的会话
       * 会被画成没置顶)。与上面 `supported: row.supported !== false` 的宽容不同:
       * 那一条缺席时的默认「支持」是安全的(点进去自然会报错),这三条缺席时没有安全默认。
       */
      ...(typeof row.isPinned === 'boolean' ? { isPinned: row.isPinned } : {}),
      ...(typeof row.unseen === 'boolean' ? { unseen: row.unseen } : {}),
      ...(typeof row.parentConversationId === 'string'
        ? { parentConversationId: row.parentConversationId }
        : {}),
      // 同一条规矩:有才带。null 是宿主说的「没有 agent」,与缺席(老宿主)不是一回事。
      ...(typeof row.agentUserId === 'string' || row.agentUserId === null ? { agentUserId: row.agentUserId as string | null } : {}),
    })
  }
  return out
}

export function normalizeDeviceCapabilities(value: unknown): DeviceCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { terminals: [], runtimes: [], host_runtime_capability: 0 }
  }
  const row = value as Record<string, unknown>
  return {
    terminals: Array.isArray(row.terminals)
      ? row.terminals.filter((terminal): terminal is string => typeof terminal === 'string' && terminal.length > 0)
      : [],
    runtimes: Array.isArray(row.runtimes)
      ? row.runtimes.filter((runtime): runtime is string => typeof runtime === 'string' && runtime.length > 0)
      : [],
    // @@@host-runtime-capability (#647) - old hosts omit the field → 0 (treated as behind every critical level).
    host_runtime_capability:
      typeof row.host_runtime_capability === 'number' && Number.isFinite(row.host_runtime_capability)
        ? row.host_runtime_capability
        : 0,
    // @@@fleet-version (#663) - old hosts omit the field → undefined (UI shows 版本未知).
    app_version:
      typeof row.app_version === 'string' && row.app_version.length > 0 ? row.app_version : undefined,
    published_desktop_version: typeof row.published_desktop_version === 'string' ? row.published_desktop_version : undefined,
    // #6264 老宿主不报这几项 ⇒ 缺席(界面退回平台名、不显示升级状态),❌ 补默认值冒充事实。
    ...(row.host_kind === 'server' || row.host_kind === 'desktop' || row.host_kind === 'phone' ? { host_kind: row.host_kind } : {}),
    ...(typeof row.os_name === 'string' && row.os_name ? { os_name: row.os_name.slice(0, 80) } : {}),
    ...(typeof row.arch === 'string' && row.arch ? { arch: row.arch.slice(0, 32) } : {}),
    // 截断的路径是另一个路径:太长就当没报,❌ 切一截冒充。
    ...(typeof row.home_dir === 'string' && row.home_dir && row.home_dir.length <= 4096 ? { home_dir: row.home_dir } : {}),
    ...(row.runs_as_root === true ? { runs_as_root: true } : {}),
    ...(row.assistant_home === true ? { assistant_home: true } : {}),
    ...normalizeServerUpdate(row.server_update),
    ...normalizeServerDisk(row.server_disk),
    ...normalizeServerRollback(row.server_rollback),
    ...(isPositiveInt(row.remote_protocol) ? { remote_protocol: row.remote_protocol } : {}),
    ...(isPositiveInt(row.min_client_protocol) ? { min_client_protocol: row.min_client_protocol } : {}),
    ...(row.connect_via === 'ssh' || row.connect_via === 'tunnel' ? { connect_via: row.connect_via } : {}),
    ...(row.tunnel_relay === 'frp' ? { tunnel_relay: 'frp' as const } : {}),
    ...(typeof row.tunnel_active_at === 'string' && row.tunnel_active_at.length <= 40 && Number.isFinite(Date.parse(row.tunnel_active_at))
      ? { tunnel_active_at: row.tunnel_active_at }
      : {}),
    // #7199 这台设备能被调用的动作(老设备不登记 ⇒ 缺席)。
    ...withDeviceActions(row.actions),
  }
}

function withDeviceActions(raw: unknown): { actions?: DeviceActionsSummary } {
  const actions = normalizeDeviceActionsSummary(raw)
  return actions ? { actions } : {}
}

const isPositiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0

function normalizeServerDisk(value: unknown): { server_disk?: DeviceServerDisk } {
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  const free = row.free_bytes
  const total = row.total_bytes
  if (typeof free !== 'number' || typeof total !== 'number' || !Number.isFinite(free) || !Number.isFinite(total)) return {}
  if (free < 0 || total <= 0 || free > total) return {}
  return { server_disk: { free_bytes: free, total_bytes: total } }
}

function normalizeServerRollback(value: unknown): { server_rollback?: DeviceServerRollback } {
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  if (typeof row.version !== 'string' || !row.version || typeof row.restored !== 'string' || !row.restored) return {}
  return { server_rollback: { version: row.version.slice(0, 64), restored: row.restored.slice(0, 64) } }
}

function normalizeServerUpdate(value: unknown): { server_update?: DeviceServerUpdate } {
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  if (row.state !== 'downloading' && row.state !== 'ready' && row.state !== 'failed') return {}
  if (typeof row.version !== 'string' || !row.version) return {}
  return { server_update: { state: row.state, version: row.version.slice(0, 64) } }
}

// @@@5912 设备在线只有一处判据(isDeviceOnline),它吃的是这个枚举 —— 所以解析也只留一处。
// 认不出的值响亮抛错,❌ 别当 offline 咽下去:那会把一列坏数据显示成「这台机器关着」。
export function normalizeDeviceStatus(value: unknown): DeviceStatus {
  if (value === 'online' || value === 'offline') return value
  throw new Error(`Invalid device status: ${String(value)}`)
}

function requiredText(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  throw new Error(`Device row is missing ${field}`)
}
