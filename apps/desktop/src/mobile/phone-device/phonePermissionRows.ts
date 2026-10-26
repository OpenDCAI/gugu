import type { PhoneActionGroup, PhoneRequirement } from './phoneActionCatalog'

export interface PhonePermissionRow {
  id: string
  group: PhoneActionGroup
  requirement: PhoneRequirement
  title: string
  purpose: string
}

export const PHONE_PERMISSION_ROWS: readonly PhonePermissionRow[] = [
  { id: 'calendar', group: 'calendar', requirement: 'calendar', title: '日历', purpose: '用来让这台手机上的任务 Agent 读取和管理日程。' },
  { id: 'contacts', group: 'contacts', requirement: 'contacts', title: '通讯录', purpose: '用来让这台手机上的任务 Agent 查找联系人。' },
  { id: 'location', group: 'location', requirement: 'location', title: '定位', purpose: '用来让这台手机上的任务 Agent 获取当前位置。' },
  { id: 'notifications', group: 'notifications', requirement: 'notification_listener', title: '通知读取', purpose: '用来让这台手机上的任务 Agent 读取其他应用的通知。' },
  { id: 'dnd', group: 'notifications', requirement: 'dnd_access', title: '勿扰', purpose: '用来让这台手机上的任务 Agent 按你的要求调整勿扰。' },
  { id: 'alarm', group: 'alarm', requirement: 'alarm_app', title: '闹钟', purpose: '用来让这台手机上的任务 Agent 设置闹钟和倒计时。' },
  { id: 'health', group: 'health', requirement: 'health_connect', title: '健康', purpose: '用来让这台手机上的任务 Agent 读取已授权的健康数据。' },
  { id: 'sms', group: 'sms', requirement: 'sms', title: '短信', purpose: '用来让这台手机上的任务 Agent 读取短信。' },
  { id: 'recordings', group: 'recordings', requirement: 'recordings', title: '录音', purpose: '用来让这台手机上的任务 Agent 读取已有录音。' },
  { id: 'photos', group: 'photos', requirement: 'photos', title: '照片', purpose: '用来让这台手机上的任务 Agent 读取已授权的照片和视频。' },
]
