import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
