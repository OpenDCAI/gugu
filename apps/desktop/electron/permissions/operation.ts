import { createHash } from 'node:crypto'
import { CORE_TOOL_RISKS, DEVICE_ACTION_RISKS } from './inventory'
import type { PermissionOperation } from './rules'

export interface PermissionCaller { ownerId: string; subjectId: string; sessionId: string; toolScope: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const targetKeys = ['chat_id', 'friend_user_id', 'to_user_ids', 'to', 'session_id', 'project_id', 'project', 'device', 'device_id',
  'target_device_id', 'app', 'market', 'tab_kind', 'file', 'file_path', 'path', 'source_message_id', 'source_attachment_id',
  'item_id', 'url', 'target', 'pid', 'window_id', 'id', 'name', 'account_id', 'to_addresses']

/** Keep JSON object order out of the binding; array order, content, attachments and every argument remain bound. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export const operationDigest = (caller: PermissionCaller, tool: string, args: unknown): string =>
  createHash('sha256').update(canonicalJson({ caller, tool, args })).digest('hex')

/** The envelope is host-owned. Only the resource selector and wrapper payload come from model arguments. */
export function permissionOperation(caller: PermissionCaller, name: string, raw: unknown): PermissionOperation {
  let args = object(raw)
  let depth = 0
  const core = /^(gugu|session-only|runtime-fork)(\+session)?(:assistant)?$/.test(caller.toolScope)
  if (core) while (name === 'catalog_call' && depth++ < 8) {
    name = typeof args.tool === 'string' ? args.tool : ''
    try { args = object(typeof args.args === 'string' ? JSON.parse(args.args) : args.args) } catch { name = ''; args = {} }
  }
  if (core && name === 'catalog_call') { name = ''; args = {} }
  let namespace = core ? 'gugu' : caller.toolScope
  let risk = core && Object.hasOwn(CORE_TOOL_RISKS, name) ? CORE_TOOL_RISKS[name] : undefined
  // This explicit variant keeps the social identity; the default archive removes its seats.
  if (core && name === 'session_archive' && args.remove_social_identity === false) risk = { risk: 'medium', effect: 'write' }
  if (core && name === 'device_call') {
    namespace = 'device'
    const device = args.device
    name = typeof args.name === 'string' ? args.name : ''
    args = { ...object(args.args), device }
    risk = Object.hasOwn(DEVICE_ACTION_RISKS, name) ? DEVICE_ACTION_RISKS[name] : undefined
  }
  // Dynamic tools are never trusted as read-only because of an App's name or MCP annotations.
  const dynamic = !core || namespace === 'gugu' && name.includes('__')
  if (dynamic && core) namespace = `app:${name.split('__')[0]}`
  const resource: Record<string, string> = {}
  for (const key of targetKeys) if (args[key] !== undefined) resource[key] = typeof args[key] === 'string' ? args[key] as string : canonicalJson(args[key])
  if (!Object.keys(resource).length) resource.session = caller.sessionId
  return { tool: name, namespace, resource, ...(risk ?? { risk: 'high', effect: 'execute' }), classified: Boolean(risk), ...(dynamic ? { dynamic: true } : {}) }
}
