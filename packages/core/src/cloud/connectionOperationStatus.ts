import {ConnectionError} from './connections'
/** Public result only. Credential generations, request digests, admission IDs
 * and native evidence are deliberately absent from this contract. */
export type ConnectionOperationStatus={
 version:1;operationId:string;scopeKey:string;resourceKey:string|null;deviceId:string|null;revision:string|null;
 operation:'save'|'remove'|'enable'|'disable';
 original:{status:string;errorCode:string|null;terminal:boolean};
 resolution:{outcome:'applied'|'failed'|'cancelled';resolvedAt:string;errorCode:string|null}|null;
 effective:{state:'confirming'|'succeeded'|'failed'|'cancelled';connectionState:'confirming'|'connected'|'disconnected'|'failed';blocksNewOperations:boolean};
 confirmation:{state:'pending'|'resolved';deadlineAt:string|null;cancelRequested?:boolean};
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown):v is string|null=>v===null||typeof v==='string'
const error=(v:unknown)=>v===null||['CONNECTION_OUTCOME_UNKNOWN','CONNECTION_FAILED','CONNECTION_CONFIRMATION_FAILED'].includes(v as string)
export function parseConnectionOperationStatus(v:unknown,operationId:string):ConnectionOperationStatus{
 const invalid=():never=>{throw new ConnectionError('invalid-response','CONNECTION_OPERATION_STATUS_INVALID')}
 if(!object(v)||v.version!==1||v.operationId!==operationId||typeof v.scopeKey!=='string'||!text(v.resourceKey)||!text(v.deviceId)||!text(v.revision)
  ||v.revision!==null&&!/^[0-9]+$/.test(v.revision)||!['save','remove','enable','disable'].includes(v.operation as string)
  ||!object(v.original)||!['pending','failed','applied','superseded'].includes(v.original.status as string)||!error(v.original.errorCode)||typeof v.original.terminal!=='boolean'
  ||!object(v.effective)||!['confirming','succeeded','failed','cancelled'].includes(v.effective.state as string)
  ||!['confirming','connected','disconnected','failed'].includes(v.effective.connectionState as string)||v.effective.blocksNewOperations!==(v.effective.state==='confirming')
  ||!object(v.confirmation)||!['pending','resolved'].includes(v.confirmation.state as string)||!text(v.confirmation.deadlineAt)||v.confirmation.cancelRequested!==undefined&&typeof v.confirmation.cancelRequested!=='boolean')return invalid()
 const resolution=v.resolution
 if(resolution!==null&&(!object(resolution)||!['applied','failed','cancelled'].includes(resolution.outcome as string)||typeof resolution.resolvedAt!=='string'||!error(resolution.errorCode)))return invalid()
 if(resolution===null&&v.original.errorCode==='CONNECTION_OUTCOME_UNKNOWN'&&v.effective.state!=='confirming')return invalid()
 if(resolution!==null&&((resolution.outcome==='applied'&&v.effective.state!=='succeeded')
  ||(resolution.outcome==='failed'&&v.effective.state!=='failed')||(resolution.outcome==='cancelled'&&v.effective.state!=='cancelled')))return invalid()
 // Reconstruct rather than returning the transport object: extra private fields
 // cannot enter a renderer cache even if a broken service accidentally adds them.
 return {version:1,operationId,scopeKey:v.scopeKey,resourceKey:v.resourceKey,deviceId:v.deviceId,revision:v.revision,operation:v.operation as ConnectionOperationStatus['operation'],
  original:{status:v.original.status as string,errorCode:v.original.errorCode as string|null,terminal:v.original.terminal},
  resolution:resolution===null?null:{outcome:resolution.outcome as 'applied'|'failed'|'cancelled',resolvedAt:resolution.resolvedAt as string,errorCode:resolution.errorCode as string|null},
  effective:{state:v.effective.state as ConnectionOperationStatus['effective']['state'],connectionState:v.effective.connectionState as ConnectionOperationStatus['effective']['connectionState'],blocksNewOperations:v.effective.blocksNewOperations as boolean},
  confirmation:{state:v.confirmation.state as 'pending'|'resolved',deadlineAt:v.confirmation.deadlineAt,...(v.confirmation.cancelRequested===undefined?{}:{cancelRequested:v.confirmation.cancelRequested as boolean})}}
}
export type ConnectionAuthorizationResult={operationId:string;scopeKey:'platform';resourceKey:string;revision:string;status:'applied'}|{operationId:string;state:'confirming'}
export function parseConnectionAuthorizationResult(value:unknown,operationId:string):ConnectionAuthorizationResult{
 if(object(value)&&value.operationId===operationId){
  if(value.state==='confirming')return{operationId,state:'confirming'}
  if(value.status==='applied'&&value.scopeKey==='platform'&&typeof value.resourceKey==='string'&&typeof value.revision==='string'&&/^[0-9]+$/.test(value.revision))
   return{operationId,scopeKey:'platform',resourceKey:value.resourceKey,revision:value.revision,status:'applied'}
 }
 throw new ConnectionError('invalid-response','CONNECTION_AUTHORIZATION_RECEIPT_INVALID')
}
