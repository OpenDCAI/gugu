import { describe, expect, it, vi } from 'vitest';
import { createRequestActivity } from '@gugu/session-core/acp';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { FakeAcpAgent } from '../acp-test-support';
import { SessionCell } from './cell';

describe('submitted image identity', () => {
  it.each([true, false])('keeps the resolved immutable ref in the committed user row (image support: %s)', async acceptsImagePrompts => {
    const ref = { id: 'stored-image', name: 'photo.png', mimeType: 'image/png' as const };
    const agent = new FakeAcpAgent();
    agent.prompt = vi.fn().mockResolvedValue({ stopReason: 'end_turn' });
    const boundary = createRequestActivity(new Proxy(agent, { get(target, key) {
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) as never, ({ event }) => cell.push(event));
    const cell = new SessionCell({ sessionId: 'conversation', projectId: 'project', providerId: 'fixture', acpSessionId: 'native',
      agent: boundary.agent, acceptsImagePrompts, logger: noopLogger,
      resolveAttachment: async () => ({ data: 'AQID', mimeType: ref.mimeType, ref }) });
    cell.applySessionReady();
    try {
      await cell.prompt({ text: '请看这张图', attachments: [{ type: 'local-file', originalPath: '/staged/photo.png', name: ref.name, mimeType: ref.mimeType }] });
      const rows = cell.history().committed.flatMap(turn => turn.items).filter(item => item.kind === 'message' && item.role === 'user');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ text: '请看这张图', attachments: [ref] });
      const blocks = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls[0]![0].prompt;
      expect(blocks.filter((block: { type: string }) => block.type === 'image')).toHaveLength(acceptsImagePrompts ? 1 : 0);
    } finally { cell.dispose(); }
  });

  it.each(['provider-input', 'conversation-1-user'])('preserves only the confirmed ref when native admission supplies %s', async messageId => {
    const ref = { id: 'stored-image', name: 'photo.png', mimeType: 'image/png' as const };
    const prompt = vi.fn(async () => {
      cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      cell.push({ kind: 'message', role: 'user', messageId, text: 'caption', contentMode: 'replace', attachments: [{ ...ref, id: 'provider-echo-image' }] });
      return { status: 'accepted' as const, requestId: 'request', messageId };
    });
    const cell = new SessionCell({ sessionId: 'conversation', projectId: 'project', providerId: 'fixture', acpSessionId: 'native',
      agent: { prompt, cancel: vi.fn() } as unknown as AcpAgentApi, acceptsImagePrompts: true, logger: noopLogger,
      resolveAttachment: async () => ({ data: 'AQID', mimeType: ref.mimeType, ref }) });
    cell.applySessionReady();
    try {
      const sent = cell.promptDetached({ text: 'caption', attachments: [{ type: 'local-file', originalPath: '/staged/photo.png', mimeType: ref.mimeType }] });
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      await sent.admission;
      cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      await sent.completion;
      const rows = cell.history().committed.flatMap(turn => turn.items).filter(item => item.kind === 'message' && item.role === 'user');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ text: 'caption', attachments: [ref] });
    } finally { cell.dispose(); }
  });
});
