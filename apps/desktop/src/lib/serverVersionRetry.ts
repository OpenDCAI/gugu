// #6264 那台咕咕 server 换成和桌面匹配的那一版没成(设备行「更新没成功 · 重试」):人点「重试」。
// 走这台机器现成的设备 RPC 线(远程隧道经咕咕云,远程 SSH 经设备连接,deviceRpc.ts 按机器挑),一次请求,❌ 轮询。
// 那台机器收到后留一个比失败更晚的换版请求,守护进程下一轮就重新下载 / 换过去;结果随它的心跳回到设备行。
import { LEGACY_VERSION_RETRY_RPC, VERSION_RETRY_RPC, VERSION_RESTART_RPC } from '@gugu/core/cloud/serverMachineHealth'
import { callDeviceRpc } from './deviceRpc'

export async function retryServerVersionMatch(deviceId: string): Promise<boolean> {
  const reply = await callDeviceRpc<{ requested?: boolean }>(deviceId, VERSION_RETRY_RPC, {}, { timeoutMs: 15_000 })
  if (reply.error) throw new Error(reply.error.message)
  return reply.result?.requested === true
}

/** 旧版本的账号进程只认旧的 retry RPC(它写的就是一个确认,守护进程把它算作对眼下目标的确认)。 */
export async function restartServerVersionNow(deviceId: string, version: string, supportsConfirmedRestart: boolean): Promise<boolean> {
  const reply = await callDeviceRpc<{ requested?: boolean }>(deviceId,
    supportsConfirmedRestart ? VERSION_RESTART_RPC : LEGACY_VERSION_RETRY_RPC,
    supportsConfirmedRestart ? { version, confirmed: true } : {}, { timeoutMs: 15_000 })
  if (reply.error) throw new Error(reply.error.message)
  return reply.result?.requested === true
}
