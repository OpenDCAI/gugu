// 免费额度跟设备走(官方会员口径「免费额度跟设备走」,owner 2026-09-25):
// 账号在这台设备上确立 owner(登录 / 启动时已登录 / 换号)时认领一次;一台设备最多给 5 个账号发。
// 云端 billing.claim_device_free_credits 幂等;本地记下结果,认领过的账号不再调。
// 调用失败 / 旧库没有这个函数 ⇒ 静默跳过,下次启动再试。❌ 挡登录,❌ 轮询。
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { atomicWriteText } from '@gugu/core'

export type DeviceClaimStatus = 'granted' | 'already_claimed' | 'device_full' | 'not_confirmed'
type ClaimStore = Record<string, DeviceClaimStatus>

const STATUSES: readonly DeviceClaimStatus[] = ['granted', 'already_claimed', 'device_full', 'not_confirmed']
/** 这两种之后这个账号在本机不必再问;device_full / not_confirmed 下次启动再问一次(便宜,且状态可能变)。 */
const SETTLED: readonly DeviceClaimStatus[] = ['granted', 'already_claimed']

/** 设备哈希:硬件标识不出本机,云端只见这串。 */
export function deviceClaimHash(machineId: string): string {
  return createHash('sha256').update(`gugu-device-v1:${machineId}`).digest('hex')
}

export interface DeviceClaimDeps {
  machineId: () => Promise<string>
  /** 调 RPC,返回 data;出错抛。 */
  claim: (accessToken: string, deviceHash: string) => Promise<unknown>
  storePath: string
  warn: (message: string) => void
}

async function readStore(path: string): Promise<ClaimStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as ClaimStore : {}
  } catch {
    return {}
  }
}

export async function readDeviceClaimStatus(storePath: string, userId: string): Promise<DeviceClaimStatus | null> {
  return (await readStore(storePath))[userId] ?? null
}

/** 认领一次。永不抛:失败返回 null(下次启动再试)。 */
export async function claimDeviceFreeCredits(
  deps: DeviceClaimDeps,
  auth: { userId: string; accessToken: string },
): Promise<DeviceClaimStatus | null> {
  try {
    const store = await readStore(deps.storePath)
    const known = store[auth.userId]
    if (known && SETTLED.includes(known)) return known
    const data = await deps.claim(auth.accessToken, deviceClaimHash(await deps.machineId()))
    const status = (data as { status?: unknown } | null)?.status as DeviceClaimStatus
    if (!STATUSES.includes(status)) throw new Error(`unexpected claim result ${JSON.stringify(data)}`)
    store[auth.userId] = status
    await atomicWriteText(deps.storePath, JSON.stringify(store))
    return status
  } catch (error) {
    deps.warn(`device free credits claim skipped: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
