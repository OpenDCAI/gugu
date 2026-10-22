import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GuguMcpRequestTracker } from '../gugu-mcp-host';
import { registerSessionpageTools, type SessionDispatcher, type SessionpageToolDef } from './sessionpage-tool-registrar';

const device_id = z.string().min(1).describe('device:<id> from session_devices; omit for this machine.').optional();
export const ACTIVITY_TOOL_DEFS: readonly SessionpageToolDef[] = [
  { name: 'activity_list', action: 'activity_list',
    description: 'Recent work activity by time, session or project. Reads persistent temporal metadata only, never prompts, replies or transcripts. Includes coverage and gaps; an empty result is not proof of no work. Agent done means a turn ended, not task acceptance. Unenrolled external CLI work is not covered. Query other devices explicitly.',
    schema: z.object({ device_id, since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }),
      session_id: z.string().min(1).optional(), project_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() }).strict() },
  { name: 'activity_context', action: 'activity_context',
    description: 'On demand, read original input and latest reply behind an activity_list event on the same device. A known turn ID locates that turn; otherwise returns four latest turns with explicit scope. Use next_before_seq to read older pages. Missing sources are reported. This does not start or message an agent.',
    schema: z.object({ device_id, event_id: z.string().min(1).max(512), before_seq: z.number().int().nonnegative().optional() }).strict() },
];
export function registerGuguActivityTools(server: McpServer, run: SessionDispatcher | undefined, track: GuguMcpRequestTracker): void {
  registerSessionpageTools(server, ACTIVITY_TOOL_DEFS, run, tool => `${tool} is unavailable for this grant`, track);
}
