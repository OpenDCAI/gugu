import type { ConnectionReceipt,ConnectionBatchReceipt,NativeConnectionAuthorization,NativeConnectionAuthorizationBatch } from '@gugu/core/cloud/connections'
export type OwnerConnectionControl = {
  prepare(expectedEpoch?: string): Promise<void>
  hold(providerId: string,operationId: string,expectedEpoch?: string): Promise<void>
  release(providerId: string,operationId: string): Promise<void>
  commitAuthorization(input: NativeConnectionAuthorization): Promise<ConnectionReceipt>
  commitAuthorizationBatch(input: NativeConnectionAuthorizationBatch): Promise<ConnectionBatchReceipt>
}
let control: OwnerConnectionControl | undefined
export function setOwnerConnectionControl(value: OwnerConnectionControl) { control = value }
export function ownerConnectionControl() {
  if (!control) throw new Error('CONNECTION_RUNTIME_UNAVAILABLE')
  return control
}
