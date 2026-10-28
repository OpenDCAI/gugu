const labels: Record<string, [string, string]> = {
  memory: ['记忆','Memory'],personality: ['性格约定','Personality'],schedules: ['定时任务','Scheduled task'],
  files: ['资料','File'],skills: ['技能','Skill'],integrations: ['应用','Application'],
  'voice-notes': ['语音笔记','Voice note'],capabilities: ['能力','Capability'],'device-notes': ['设备说明','Device note'],
}

/** Stable public categories. Native/provider diagnostics never become UI copy. */
export function panelApplicationFailure(domain: string, resource: string, code: string, locale: string, operation?: string): string {
  const english = locale.startsWith('en'), index = english ? 1 : 0
  const label = (labels[domain] ?? ['面板资料','Panel resource'])[index]
  const reasons: Record<string, [string,string]> = {
    EACCES: ['没有读写权限','Permission to read or write this item was denied'],
    EPERM: ['没有修改权限','Permission to change this item was denied'],
    EBUSY: ['文件正被其他操作占用','The file is in use'],
    ENOSPC: ['可用存储空间不足','There is not enough storage space'],
    PANEL_SCHEDULE_NOT_OWNED: ['这项定时任务不属于当前助理','The scheduled task does not belong to this assistant'],
    RESOURCE_DELETED: ['该条目已不存在','The item no longer exists'],
    PANEL_RESOURCE_REMOVED: ['该条目已不存在','The item no longer exists'],
    PANEL_BODY_TIMEOUT: ['读取正文超时','Reading the content timed out'],
    CHANGE_ACK_UNAVAILABLE: ['暂时无法记录处理结果','The outcome could not be recorded'],
    CONCURRENT_CHANGES_RETRY: ['仍有新的面板变更正在整理','Additional panel changes are being reconciled'],
  }
  const reason = (reasons[code] ?? ['处理过程中未能完成读写','The resource update could not complete'])[index]
  return english ? `${label} “${resource}” ${operation === 'remove' ? 'deletion cleanup could not finish' : 'could not be applied'}: ${reason}.`
    : `${label}「${resource}」${operation === 'remove' ? '的删除清理未完成' : '未能应用'}：${reason}。`
}
