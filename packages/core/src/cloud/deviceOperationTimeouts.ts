import {
  withAbortSignal,
  withBoundedOperation,
  type AbortablePromiseLike,
} from './boundedOperation'

export interface DeviceOperationTimeouts {
  machineIdentifierMs: number
  deviceLookupMs: number
  deviceCacheWriteMs: number
  heartbeatUpsertMs: number
  heartbeatCleanupMs: number
  runtimeStateWriteMs: number
  runtimeInstanceHeartbeatMs: number
  orphanRecoveryMs: number
  pendingCommandListMs: number
  commandLeaseMs: number
  commandSettlementMs: number
}

export type DeviceOperationTimeoutOverrides = Partial<DeviceOperationTimeouts>

export const DEVICE_OPERATION_TIMEOUTS: Readonly<DeviceOperationTimeouts> = {
  machineIdentifierMs: 5_000,
  deviceLookupMs: 10_000,
  deviceCacheWriteMs: 5_000,
  heartbeatUpsertMs: 10_000,
  heartbeatCleanupMs: 30_000,
  runtimeStateWriteMs: 10_000,
  runtimeInstanceHeartbeatMs: 5_000,
  orphanRecoveryMs: 30_000,
  pendingCommandListMs: 15_000,
  commandLeaseMs: 10_000,
  commandSettlementMs: 10_000,
}

export class DeviceOperationTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`)
    this.name = 'DeviceOperationTimeoutError'
  }
}

export function resolveDeviceOperationTimeouts(
  overrides: DeviceOperationTimeoutOverrides | undefined,
): Readonly<DeviceOperationTimeouts> {
  return { ...DEVICE_OPERATION_TIMEOUTS, ...overrides }
}

export async function runDeviceOperation<T>(
  operation: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => PromiseLike<T> | T,
): Promise<T> {
  return await withBoundedOperation(
    timeoutMs,
    () => new DeviceOperationTimeoutError(operation, timeoutMs),
    run,
  )
}

export async function runDeviceRequest<T>(
  operation: string,
  timeoutMs: number,
  request: (signal: AbortSignal) => AbortablePromiseLike<T>,
): Promise<T> {
  return await runDeviceOperation(
    operation,
    timeoutMs,
    (signal) => withAbortSignal(request(signal), signal),
  )
}
