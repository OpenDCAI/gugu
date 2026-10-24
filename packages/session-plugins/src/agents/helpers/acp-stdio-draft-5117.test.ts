import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { routeSessionUpdates } from './acp-stdio';

async function route(messages: unknown[]) {
  const text = messages.map(message => JSON.stringify(message)).join('\n');
  const bytes = new TextEncoder().encode(text);
  const delivered: unknown[] = [];
  const source = new ReadableStream<Uint8Array>({ start(controller) {
    // Split inside multibyte characters as well as between JSON frames.
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } });
  const output = await new Response(routeSessionUpdates(source, params => delivered.push(params))).text();
  return { delivered, output: output.split('\n').filter(Boolean).map(line => JSON.parse(line) as unknown) };
}
const notification = (update: unknown) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'root', update } });

describe('v1 negotiated extensions are decoded at the transport boundary', () => {
  it.each([
    { sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: '审阅' },
    { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' },
    { sessionUpdate: 'async_task_spawned', asyncTaskId: 'task', name: '命令' },
    { sessionUpdate: 'async_task_progress', asyncTaskId: 'task', summary: 'working' },
    { sessionUpdate: 'async_task_state_update', asyncTaskId: 'task', state: 'completed' },
    { sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'in_progress' },
    { sessionUpdate: 'compaction_summary_chunk', compactionId: 'compact', content: { type: 'text', text: '摘要' } },
    { sessionUpdate: 'notice', title: 'Task stopped by user', description: 'Stopped' },
  ])('delivers $sessionUpdate without a tool envelope', async update => {
    const message = notification(update);
    const result = await route([message]);
    expect(result.delivered).toEqual([message.params]);
    expect(result.output).toEqual([]);
    expect(decodeSessionUpdate(update).kind).not.toBe('tool_update');
  });

  it('decodes ordinary updates in the same path and preserves malformed extensions for loud validation', async () => {
    const ordinary = notification({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '正常' } });
    const messages = [ordinary,
      notification({ sessionUpdate: 'subagent_spawned' }),
      { ...notification({ sessionUpdate: 'notice' }), params: { sessionId: 17, update: { sessionUpdate: 'notice' } } },
      { jsonrpc: '2.0', id: 1, result: {} }];
    expect(await route(messages)).toEqual({ delivered: [ordinary.params], output: messages.slice(1) });
  });
});
