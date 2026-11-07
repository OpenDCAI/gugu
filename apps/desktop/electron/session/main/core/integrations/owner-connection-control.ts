import type { ConnectionReceipt,ConnectionBatchReceipt,NativeConnectionAuthorization,NativeConnectionAuthorizationBatch } from '@gugu/core/cloud/connections'
export type OwnerConnectionControl = {
  runAuthorization<T>(providerId:string,operationId:string,epoch:string,action:()=>Promise<T>):Promise<T>
  readEvidence(input:unknown,ownerId:string):Promise<unknown>
  fenceEvidence(input:unknown,ownerId:string):Promise<unknown>
  prepareAuthorization(providerId:string,operationId:string,epoch:string):Promise<void>
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
