import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { registerSessionpageTools, type SessionDispatcher, type SessionpageToolDef } from './sessionpage-tool-registrar'
import { listWindowShape } from './list-window.mjs'

const project_id = z.string().min(1).describe('project:<id> from project_list or session_get; omit for this session’s project on this machine; required on another device.').optional()
const device_id = z.string().min(1).describe('device:<id> from session_devices; omit for this machine.').optional()
const path = z.string().min(1).describe('An existing absolute folder path on the specified device.')

export const PROJECT_TOOL_DEFS: readonly SessionpageToolDef[] = [
  { name: 'project_list', action: 'project_list', description: 'List projects on one of your devices. A project can span devices; project_get lists its folders on this device.', schema: z.object({ device_id, ...listWindowShape, name: z.string().optional() }).strict(), list: { namesOf: (row) => [row.name, row.path] } },
  { name: 'project_create', action: 'project_create', description: 'Create a named project from an existing folder on your device. Uses the same path ownership rules as the UI; does not start an agent or initialize Git.', schema: z.object({ device_id, name: z.string().min(1), path }).strict() },
  { name: 'project_get', action: 'project_get', description: 'Read a project, its group and its folders on this device. Folder IDs come from this result. Ensures the calling agent can access the project group; inspect group_access before messaging.', schema: z.object({ project_id, device_id }).strict() },
  { name: 'project_add_folder', action: 'project_add_folder', description: 'Attach a folder on this device. Another project’s root joins this project group; if it has sessions, ask the owner before repeating with merge_existing:true and source_project_id. Files, sessions and old group history stay; post group_notice and keep undo.', schema: z.object({ project_id, device_id, path, merge_existing: z.boolean().optional(), source_project_id: z.string().min(1).describe('project:<id> from this tool’s confirmation result; required with merge_existing:true.').optional() }).strict() },
  { name: 'project_remove_folder', action: 'project_remove_folder', description: 'Detach folders to remove a project; files, sessions and history are never deleted. Use folder_id from project_get, including the root. Projects leave the list only without folders or unarchived sessions; history stays restorable. Returns undo; post group_notice.', schema: z.object({ project_id, device_id, folder_id: z.string().min(1) }).strict() },
  { name: 'project_add_device', action: 'project_add_device', description: 'Link a folder on another owned device into this project. Both parts share one project group. Existing populated projects require the owner’s confirmation before merge_existing:true. Post returned group_notice.', schema: z.object({ project_id, device_id, target_device_id: z.string().min(1).describe('device:<id> from session_devices.'), path, merge_existing: z.boolean().optional() }).strict() },
  { name: 'project_remove_device', action: 'project_remove_device', description: 'Unlink this device’s local project from its shared project group. Keeps files, sessions and the original group history. Use project_get on that device to identify it. Post returned group_notice.', schema: z.object({ project_id, device_id }).strict() },
  { name: 'project_restore_device', action: 'project_restore_device', description: 'Restore a project’s previous group with returned undo arguments from project_remove_device or an existing-root project_add_folder. Keeps files and sessions; refuses to overwrite a newer association. Post returned group_notice.', schema: z.object({ project_id, device_id, chat_id: z.string().uuid(), expected_chat_id: z.string().uuid().nullable() }).strict() },
]

export function registerGuguProjectTools(server: McpServer, run: SessionDispatcher | undefined, track: GuguMcpRequestTracker): void {
  const dispatch: SessionDispatcher | undefined = run ? async (action, signal) => {
    const result = await run(action, signal)
    const device = (action as { device?: string }).device
    // Lists must reach the shared paginator as arrays; spreading a remote list
    // into an object loses its shape before windowResult can read it.
    if (!device || !result || typeof result !== 'object' || Array.isArray(result)) return result
    const record = result as Record<string, unknown>
    return {
      ...record,
      ...(record.undo && typeof record.undo === 'object' ? { undo: { device_id: device, ...record.undo } } : {}),
      ...(record.group_notice && typeof record.group_notice === 'object' ? { group_notice: { device_id: device, ...record.group_notice } } : {}),
    }
  } : undefined
  registerSessionpageTools(server, PROJECT_TOOL_DEFS, dispatch, (tool) => `${tool} is unavailable for this grant`, track)
}
