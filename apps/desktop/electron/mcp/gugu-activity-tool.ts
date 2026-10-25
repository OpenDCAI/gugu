import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GuguMcpRequestTracker } from '../gugu-mcp-host';
import { registerSessionpageTools, type SessionDispatcher, type SessionpageToolDef } from './sessionpage-tool-registrar';

const device_id = z.string().min(1).describe('device:<id> from session_devices.').optional();
export const ACTIVITY_TOOL_DEFS: readonly SessionpageToolDef[] = [
  { name: 'activity_list', action: 'activity_list',
    description: 'Metadata for what agents did and when. Chat claims are not executor records. All task devices unless device_id selects one. Gaps mean no record, not no work. Turn done is not acceptance; external CLI must enroll. activity_context reads sources.',
    schema: z.object({ device_id, since: z.string().datetime({ offset: true }), until: z.string().datetime({ offset: true }),
      session_id: z.string().min(1).optional(), project_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(), cursor: z.string().optional() }).strict() },
  { name: 'activity_context', action: 'activity_context',
    description: 'On demand, read original input and latest reply behind an activity_list event on the same device. A session.turn_recorded event returns that turn; other events return four latest turns with explicit scope. Use next_before_seq to read older pages. Missing sources are reported. This does not start or message an agent.',
    schema: z.object({ device_id: device_id.describe('Event device from activity_list; omit for this machine.'), event_id: z.string().min(1).max(512), before_seq: z.number().int().nonnegative().optional() }).strict() },
];
export function registerGuguActivityTools(server: McpServer, run: SessionDispatcher | undefined, track: GuguMcpRequestTracker): void {
  registerSessionpageTools(server, ACTIVITY_TOOL_DEFS, run, tool => `${tool} is unavailable for this grant`, track);
}
