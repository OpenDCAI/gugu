import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createActivitySummaryQuery } from '../../../../apps/desktop/electron/activity-summary-query';
import { createCrossMachineSessions } from '../../../../apps/desktop/electron/cross-machine-sessions';
import type { Device } from '@gugu/core/shared/types/chat';
import type { RemoteSessionCaller } from '@gugu/session-core/session-record/contract';
import { registerGuguActivityTools } from '../../../../apps/desktop/electron/mcp/gugu-activity-tool';
// @ts-expect-error -- ESM tool definitions.
import { chatActivityTool } from '../../../../apps/desktop/electron/mcp/chat-activity.mjs';

describe('activity tools at the real MCP boundary', () => {
  it('decodes device/session filters and returns typed references without enriching previews', async () => {
    const server = new McpServer({ name: 'activity-test', version: '1' });
    const dispatch = vi.fn(async (_action: unknown) => ({ events: [{ event_id: 'e1', session_id: 's1' }], next_cursor: null }));
    registerGuguActivityTools(server, dispatch, work => work);
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const result = await client.callTool({ name: 'activity_list', arguments: {
        device_id: 'device:d1', session_id: 'session:s1', since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z',
      } });
      expect(dispatch.mock.calls[0][0]).toMatchObject({ action: 'activity_list', device: 'd1', session_id: 's1' });
      expect(result.content).toMatchObject([{ text: expect.stringContaining('session:s1') }]);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { await client.close(); await server.close(); }
  });
  it('aggregates typed device references through the existing authenticated Agent control RPC', async () => {
    const since = '2026-10-25T00:00:00Z', until = '2026-10-25T01:00:00Z';
    const start = Date.parse(since), end = Date.parse(until);
    const source = (id: string) => ({ events: [{ event_id: id, kind: 'session.created', occurred_at: start + 1,
      observed_at: start + 1, sequence: 1, session_id: 's1' }], session_titles: { s1: '工作会话' }, next_cursor: null,
      coverage: { queried_at: end, collector_running: true, segments: [{ started_at: start, ended_at: end, last_seen_at: end }],
        untracked: [], note: 'Metadata only' } });
    const devices = ['cloud', 'mac', 'offline'].map(id => ({ device_id: id, label: id, platform: 'darwin',
      hostname: id, status: id === 'offline' ? 'offline' : 'online', is_online: id !== 'offline',
      last_seen_at: since, capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 } } as Device));
    const caller: RemoteSessionCaller = { deviceId: 'cloud', deviceLabel: 'Cloud', sessionId: 'caller', agentUserId: 'agent',
      name: 'Assistant', harness: 'claude', transport: 'acp', model: null, platformModel: null };
    const request = vi.fn(async () => ({ result: { value: source('mac-event') } }));
    const cross = createCrossMachineSessions({ thisDeviceId: async () => 'cloud', listDevices: async () => devices,
      lookupAgents: async () => [], requester: { call: request } });
    const aggregate = createActivitySummaryQuery();
    const server = new McpServer({ name: 'aggregate-test', version: '1' });
    registerGuguActivityTools(server, (action, signal) => aggregate(action as Record<string, unknown>, {
      scope: 'owner:caller', devices: () => cross.activityDevices(),
      query: (device, query, stepSignal) => device.this_machine ? Promise.resolve(source('cloud-event'))
        : cross.runOnDevice(device.device_id, caller, { action: 'activity_list', ...query }, stepSignal),
    }, signal), work => work);
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const result = await client.callTool({ name: 'activity_list', arguments: { since, until } });
      const value = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(value.sessions.map((e: { device_id: string }) => e.device_id)).toEqual(['device:cloud', 'device:mac']);
      expect(value.sessions[0]).toMatchObject({ session_id: 'session:s1', session_name: '工作会话' });
      expect(value).not.toHaveProperty('events');
      expect(value.gaps).toContainEqual(expect.objectContaining({ device_id: 'device:offline', reason: 'offline', statement: '未采集，不能断定在不在工作' }));
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith('mac', 'taskhost.call', { channel: 'agentSession.activity_list',
        args: [caller, expect.objectContaining({ action: 'activity_list', since, until })] }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    } finally { await client.close(); await server.close(); }
  });
  it('always passes the calling agent to cloud metadata RPC and binds pagination to that actor', async () => {
    const tool = chatActivityTool(async () => 'chat1');
    const restRpc = vi.fn(async () => ({ events: [{ kind: 'message_created', message_id: 'm1' }],
      next_revision: 9, through_revision: 12, coverage: {} }));
    const query = { since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z', chat_id: '213103' };
    const deps = { context: { agentId: 'agent1' }, restRpc };
    const page = JSON.parse(await tool.handler(query, deps));
    expect(restRpc).toHaveBeenCalledWith('activity_metadata_as', expect.objectContaining({ p_as_user_id: 'agent1', p_chat_id: 'chat1' }));
    await tool.handler({ ...query, cursor: page.next_cursor }, deps);
    expect(restRpc).toHaveBeenLastCalledWith('activity_metadata_as', expect.objectContaining({ p_after_revision: 9, p_through_revision: 12 }));
    await expect(tool.handler({ ...query, cursor: page.next_cursor }, { ...deps, context: { agentId: 'agent2' } })).rejects.toThrow(/actor or query/);
    expect(restRpc).toHaveBeenCalledTimes(2);
  });
});
