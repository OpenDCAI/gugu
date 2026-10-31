/**
 * #6264 咕咕 server 的机器上限(owner 2026-09-24):「远程 SSH 不限。其实总机器上限就是 10 台，
 * 但是那个云机器上限就是 3 台」「一开始不用披露，等用户碰到设备上限了再触发」。
 *
 * 库在两处拦(nmhjklnm/gugu-supabase 迁移 *_machine_limits_6264):
 *  · 登录时 —— server-login 的 poll 回 `{ error: 'machine_limit', limit, used, max }`;
 *  · 设备行落库时 —— 心跳被拒 `DEVICE_LIMIT_REACHED: {"limit":…,"used":…,"max":…}`。
 * 这里只管把两种形状读成同一个对象、说成同一句人话(server 终端与日志用;桌面走 i18n,措辞一致)。
 */

import { REMOTE_TUNNEL_OPEN } from './remoteTunnel'

export type MachineLimitKind = 'total' | 'tunnel'

export type MachineLimitMachine = {
  machine_id: string
  label: string
  /** Every registered endpoint of this physical machine, including other versions. */
  device_ids: string[]
}

export type MachineLimitRequest = { machine_id: string; via: 'ssh' | 'tunnel' }

export type MachineLimitRefusal = {
  /** total = 咕咕 server 总数;tunnel = 其中经咕咕云连着的(远程隧道)。 */
  limit: MachineLimitKind
  /** 除了这台之外已经连着几台。 */
  used: number
  max: number
  /** Older backends omit the request and occupant inventory. */
  machine_id?: string
  via?: 'ssh' | 'tunnel'
  machines?: MachineLimitMachine[]
}

export const DEVICE_LIMIT_REACHED_PREFIX = 'DEVICE_LIMIT_REACHED'
/** server-login poll 的错误码;`gugu-server login --grant-stdin` 也用它当给桌面看的标记。 */
export const MACHINE_LIMIT_ERROR = 'machine_limit'

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** 从库给的 JSON(或已解析的对象)读出上限原因;形状不对 = null。 */
export function parseMachineLimitRefusal(value: unknown): MachineLimitRefusal | null {
  let data = value
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const limit = record.limit
  const used = count(record.used)
  const max = count(record.max)
  if ((limit !== 'total' && limit !== 'tunnel') || used === null || max === null) return null
  let machines: MachineLimitMachine[] | undefined
  if (record.machines !== undefined) {
    if (!Array.isArray(record.machines)) return null
    machines = []
    for (const value of record.machines) {
      if (!value || typeof value !== 'object') return null
      const machine = value as Record<string, unknown>
      if (typeof machine.machine_id !== 'string' || !machine.machine_id
        || typeof machine.label !== 'string' || !Array.isArray(machine.device_ids)
        || machine.device_ids.length === 0
        || !machine.device_ids.every((id): id is string => typeof id === 'string' && id.length > 0)) return null
      machines.push({ machine_id: machine.machine_id, label: machine.label, device_ids: machine.device_ids })
    }
  }
  return {
    limit, used, max,
    ...(typeof record.machine_id === 'string' && record.machine_id ? { machine_id: record.machine_id } : {}),
    ...(record.via === 'ssh' || record.via === 'tunnel' ? { via: record.via } : {}),
    ...(machines ? { machines } : {}),
  }
}

/** 心跳被拒的那句(`DEVICE_LIMIT_REACHED: {...}`)→ 上限原因;不是这一种错误 = null。 */
export function machineLimitRefusalFromError(error: unknown): MachineLimitRefusal | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const at = message.indexOf(DEVICE_LIMIT_REACHED_PREFIX)
  if (at < 0) return null
  const json = message.slice(at + DEVICE_LIMIT_REACHED_PREFIX.length).replace(/^\s*:\s*/, '')
  const end = json.lastIndexOf('}')
  return parseMachineLimitRefusal(end >= 0 ? json.slice(0, end + 1) : json)
}

/** 哪条上限、用了几台。与确认页(gugu-supabase server-login/page.ts)同一套措辞。 */
export function machineLimitMessage(refusal: MachineLimitRefusal | null): string {
  if (refusal?.limit === 'tunnel') {
    return `经咕咕云连接（远程隧道）的咕咕 server 最多 ${refusal.max} 台，你已经连了 ${refusal.used} 台。从咕咕桌面用远程 SSH 添加的机器不占这个名额。`
  }
  if (refusal?.limit === 'total') {
    return `你的账号最多连 ${refusal.max} 台咕咕 server，已经连了 ${refusal.used} 台。`
  }
  return '你的账号连的咕咕 server 已经到上限了。'
}

/** 下一步去哪:server 终端里说的那一句。 */
export const MACHINE_LIMIT_NEXT_STEP = `在咕咕桌面「设置 → 设备」里移除一台不用的机器，或在「设置 → 会员与额度」升级会员，然后${
  REMOTE_TUNNEL_OPEN ? '重新执行 gugu-server login' : '重新用远程 SSH 添加这台机器'
}。`

export interface MachineLimitCheckRpcClient {
  rpc(fn: 'gugu_machine_limit_refusal', args: { p_user_id: string; p_machine_id: string; p_via: 'ssh' | 'tunnel' }):
    PromiseLike<{ data: unknown; error: { message: string } | null }>
}

/** Reuse the enforcement RPC so the notice never classifies quota occupants itself. */
export async function checkMachineLimitRefusal(client: MachineLimitCheckRpcClient, ownerId: string, request: MachineLimitRequest): Promise<MachineLimitRefusal | null> {
  if (!ownerId) throw new Error('Machine limit checks require an owner')
  const { data, error } = await client.rpc('gugu_machine_limit_refusal', {
    p_user_id: ownerId, p_machine_id: request.machine_id, p_via: request.via,
  })
  if (error) throw new Error(error.message)
  if (data === null) return null
  const refusal = parseMachineLimitRefusal(data)
  if (!refusal) throw new Error('Invalid machine limit response')
  return refusal
}
