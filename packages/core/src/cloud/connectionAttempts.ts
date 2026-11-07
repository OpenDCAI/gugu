/** Internal custody identity for desktop/server hosts. This DTO must never be
 * forwarded through the public operation-status endpoint or rendered in UI. */
export type NativeConnectionAttempt = {
  operationId: string; attemptId: string; attemptOrder: string; ownerId: string; deviceId: string;
  scopeKey: string; resourceKey: string | null; providerId: string;
  accountId: string | null; credentialGeneration: string; authorityEpoch: string;
  requestHash: string; operationRevision: string | null; admissionId: string | null;
  recreationId: string | null; expectedItemRevision: string | null; expectedHeadRevision: string | null;
  deadlineAt: number; effectKind: 'authorize' | 'default' | 'remove';
}
export type NativeConnectionEvidenceQuery = Pick<NativeConnectionAttempt,'operationId' | 'attemptId' | 'ownerId' | 'deviceId'>
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
const revision=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n
const optionalString=(value:unknown)=>value===null||typeof value==='string'&&value.length>0&&value.length<=512
export function parseNativeConnectionAttempt(value:unknown,invalid:()=>never=()=>{throw Error('CONNECTION_ATTEMPT_INVALID')}):NativeConnectionAttempt {
  if(!object(value)||!revision(value.attemptOrder)||!uuid(value.operationId)||!uuid(value.attemptId)||!uuid(value.ownerId)||!uuid(value.credentialGeneration)
    ||typeof value.deviceId!=='string'||!value.deviceId||value.deviceId.length>256||value.scopeKey!==`device:${value.deviceId}`
    ||!optionalString(value.resourceKey)||!optionalString(value.accountId)||typeof value.providerId!=='string'
    ||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.providerId)||!revision(value.authorityEpoch)
    ||value.recreationId!==null&&!uuid(value.recreationId)||value.expectedItemRevision!==null&&!revision(value.expectedItemRevision)
    ||value.expectedHeadRevision!==null&&!revision(value.expectedHeadRevision)
    ||value.operationRevision!==null&&!revision(value.operationRevision)||value.admissionId!==null&&!uuid(value.admissionId)
    ||typeof value.requestHash!=='string'||!/^[0-9a-f]{64}$/.test(value.requestHash)
    ||!Number.isSafeInteger(value.deadlineAt)||(value.deadlineAt as number)<=0||!['authorize','default','remove'].includes(value.effectKind as string))return invalid()
  // Deliberate field projection prevents an untrusted response from attaching
  // arbitrary data or credentials to the durable native evidence record.
  return {operationId:value.operationId,attemptId:value.attemptId,attemptOrder:value.attemptOrder,ownerId:value.ownerId,deviceId:value.deviceId,
    scopeKey:value.scopeKey as string,resourceKey:value.resourceKey as string|null,providerId:value.providerId,accountId:value.accountId as string|null,
    credentialGeneration:value.credentialGeneration,authorityEpoch:value.authorityEpoch,requestHash:value.requestHash,
    operationRevision:value.operationRevision as string|null,admissionId:value.admissionId as string|null,
    recreationId:value.recreationId as string|null,expectedItemRevision:value.expectedItemRevision as string|null,
    expectedHeadRevision:value.expectedHeadRevision as string|null,
    deadlineAt:value.deadlineAt as number,effectKind:value.effectKind as NativeConnectionAttempt['effectKind']}
}
