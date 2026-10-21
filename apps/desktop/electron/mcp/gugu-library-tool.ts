import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { GuguMcpRequestTracker } from '../gugu-mcp-host'
import { registerSessionpageTools, type SessionDispatcher, type SessionpageToolDef } from './sessionpage-tool-registrar'

const device_id = z.string().min(1).describe('device:<id> from session_devices; omit for this machine.').optional()
const kind = z.enum(['capabilities', 'devices'])
export const LIBRARY_TOOL_DEFS: readonly SessionpageToolDef[] = [
  { name: 'library_list', action: 'library_list', description: 'Locate Gugu’s built-in capability and device notes on a device. No plugin or external configuration is required. Use project_list for Gugu projects, session_devices/device_actions for real device grants, and the assistant memory folder for durable personal memory.', schema: z.object({ device_id }).strict() },
  { name: 'library_read', action: 'library_read', description: 'Read the derived structured index, or one entry by its ID. Notes describe usage, not live authorization; verify current device and service availability. Credentials remain on their device.', schema: z.object({ device_id, kind, entry: z.string().min(1).optional() }).strict() },
  { name: 'library_write', action: 'library_write', description: 'Create or update one Gugu capability/device note with a name, group, description and Markdown instructions. Do not store credentials. For updates, read first and pass the exact modifiedAt as expectedModifiedAt; omitted id creates a new entry. This only saves notes; it does not grant access or install/connect services.', schema: z.object({ device_id, kind, id: z.string().min(1).optional(), name: z.string().min(1), description: z.string(), group: z.string().nullable(), content: z.string(), expectedModifiedAt: z.string().optional() }).strict() },
]

export function registerGuguLibraryTools(server: McpServer, run: SessionDispatcher | undefined, track: GuguMcpRequestTracker): void {
  registerSessionpageTools(server, LIBRARY_TOOL_DEFS, run, tool => `${tool} is unavailable for this grant`, track)
}
