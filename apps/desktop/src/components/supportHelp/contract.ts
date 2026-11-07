export type HelpAvailability = 'available' | 'full' | 'archived' | 'closed' | 'invite_only'
export interface HelpIdentity { id: string; display_name: string }
export interface SupportHelpInfo {
  support_help_entry_enabled: true
  version: number
  group: {
    id: string | null; public_id: number; name: string; join_mode: 'open' | 'approval' | 'invite_only'
    is_member: boolean; join_request_status: 'pending' | null; availability: HelpAvailability
  }
  duty_human: HelpIdentity | null
  assistants: HelpIdentity[]
}
export type HelpInfo = SupportHelpInfo | { support_help_entry_enabled: false }
export function isSupportHelpInfo(value: HelpInfo | undefined): value is SupportHelpInfo {
  return value?.support_help_entry_enabled === true
}
export type HelpJoinResult =
  | { status: 'joined'; chat_id: string }
  | { status: 'pending' | 'config_changed' | 'unavailable' | 'login_required'; info: HelpInfo }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid help response')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid help text')
  return value
}
function identity(value: unknown): HelpIdentity {
  const row = object(value)
  return { id: text(row.id), display_name: text(row.display_name) }
}
/** Missing release flags/configuration are closed; malformed enabled responses fail loudly. */
export function readHelpInfo(value: unknown): HelpInfo {
  const row = object(value)
  if (row.support_help_entry_enabled !== true || row.group == null) return { support_help_entry_enabled: false }
  const group = object(row.group)
  if (!Number.isSafeInteger(row.version) || Number(row.version) < 1
    || !Number.isSafeInteger(group.public_id) || Number(group.public_id) < 1
    || !['open', 'approval', 'invite_only'].includes(String(group.join_mode))
    || !['available', 'full', 'archived', 'closed', 'invite_only'].includes(String(group.availability))
    || typeof group.is_member !== 'boolean'
    || (group.join_request_status !== null && group.join_request_status !== 'pending')
    || !Array.isArray(row.assistants)) throw new Error('Invalid help configuration')
  return {
    support_help_entry_enabled: true, version: Number(row.version),
    group: {
      id: group.id === null ? null : text(group.id), public_id: Number(group.public_id), name: text(group.name),
      join_mode: group.join_mode as SupportHelpInfo['group']['join_mode'],
      is_member: group.is_member, join_request_status: group.join_request_status,
      availability: group.availability as HelpAvailability,
    },
    duty_human: row.duty_human == null ? null : identity(row.duty_human),
    assistants: row.assistants.map(identity),
  }
}
export function readHelpJoin(value: unknown): HelpJoinResult {
  const row = object(value)
  if (row.status === 'joined') return { status: 'joined', chat_id: text(row.chat_id) }
  if (!['pending', 'config_changed', 'unavailable', 'login_required'].includes(String(row.status))) throw new Error('Invalid help join result')
  return { status: row.status as 'pending' | 'config_changed' | 'unavailable' | 'login_required', info: readHelpInfo(row.info) }
}
