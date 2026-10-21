import { callDeviceRpc, type DeviceRpcResponse } from './deviceRpc'
import {
  normalizeDeviceFsListResult,
  normalizeDeviceFsMakeDirectoryResult,
  type DeviceFsListPayload,
  type DeviceFsListResult,
  type DeviceFsMakeDirectoryResult,
} from '@gugu/core/cloud/deviceFsProtocol'

export async function deviceFsListDirectory(
  deviceId: string,
  payload: DeviceFsListPayload,
  options?: { timeoutMs?: number; signal?: AbortSignal; retryOnTimeout?: boolean },
): Promise<DeviceRpcResponse<DeviceFsListResult>> {
  const response = await callDeviceRpc<unknown>(
    deviceId,
    'fs.list-directory',
    payload,
    { ...options, retryOnTimeout: options?.retryOnTimeout ?? true },
  )
  return {
    result: normalizeDeviceFsListResult(response.result),
    error: response.error,
  }
}

/** 在那台机器上新建一个文件夹。老版本的机器不认这个请求,回 `unknown_method`,由调用方如实说出来。 */
export async function deviceFsMakeDirectory(
  deviceId: string,
  path: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<DeviceRpcResponse<DeviceFsMakeDirectoryResult>> {
  const response = await callDeviceRpc<unknown>(
    deviceId,
    'fs.make-directory',
    { path },
    // 建文件夹不是幂等的:超时后重发,第二次会撞上第一次建好的那个、报「已存在」。
    { ...options, retryOnTimeout: false },
  )
  return {
    result: normalizeDeviceFsMakeDirectoryResult(response.result),
    error: response.error,
  }
}
