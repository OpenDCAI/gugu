/** Stable categories shared with the server's per-work notice/wake grouping. */
export function assistantWorkNoticeReason(value:string|null|undefined):string {
  const code=value?.toUpperCase()??''
  if(['REPORT_MISSING','EXECUTION_FAILED','INTERRUPTED','SOURCE_UNAVAILABLE','INCOMPATIBLE','UNREACHABLE','NO_RESPONSE','PERMISSION','DELIVERY_FAILED'].includes(code)) return code
  if(['EXECUTOR_ENDED_WITHOUT_REPORT','LEGACY_REPORT_MISSING'].includes(code)) return 'REPORT_MISSING'
  if(code==='EXECUTOR_FAILED') return 'EXECUTION_FAILED'
  if(['HOST_FAILURE','EXECUTOR_CANCELLED_WITHOUT_REPORT'].includes(code)) return 'INTERRUPTED'
  if(['DELIVERY_HOST_OUTDATED','UNKNOWN_METHOD','SESSION_DEVICE_OUTDATED'].includes(code)) return 'INCOMPATIBLE'
  if(['DEVICE_UNREACHABLE','DEVICE_OFFLINE','SESSION_DEVICE_UNREACHABLE','SESSION_DEVICE_OFFLINE'].includes(code)) return 'UNREACHABLE'
  if(code.includes('TIMEOUT')||code==='DELIVERY_EXPIRED') return 'NO_RESPONSE'
  if(code.includes('AUTH')||code.includes('PERMISSION')||code==='42501') return 'PERMISSION'
  return 'DELIVERY_FAILED'
}
