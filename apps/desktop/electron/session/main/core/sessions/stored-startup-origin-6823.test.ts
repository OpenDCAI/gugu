import { describe, expect, it } from 'vitest';
import { buildSessionDirectEnvelope, mergeDeliveryEnvelopes } from '@gugu/core/local/agent/deliveryEnvelope';
import { mapSessionRowToSession } from './utils';

/**
 * #6823 启动队列的来路由生产者写明;#6823 之前落库的载荷没有这一格,而「重来」会把它们原样重投
 * (2026-09-30 实测:Windows Beta 246 行、mac1 173 行)。读行那一处用 core 的信封读方补上 ——
 * 旧 runtime 里那条正则只认单条 `<gugu_delivery`,把批和退役写法都判成人当面打的字。
 */
function storedRow(config: Record<string, unknown>) {
  return {
    id: 'c1', projectId: 'p1', title: 'T', provider: 'codex', runtime: 'acp', providerSessionId: null,
    createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z', lastInteractedAt: null,
    isInitialSession: false, agentStatus: null, agentStatusSeen: 1, agentStatusDetail: null, isPinned: 0,
    archivedAt: null, parentSessionId: null, spawnedBySessionId: null, spawnedByExtensionId: null,
    config: { version: '1', type: 'acp', agentDisplayName: 'T', ...config },
  } as never;
}

const envelope = (messageId: string, content: string) => buildSessionDirectEnvelope({
  senderSessionId: 's-parent', senderTitle: 'Codex 1', messageId, content, at: '2026-09-20 11:15 北京时间',
});
const batch = mergeDeliveryEnvelopes([envelope('m-1', 'first'), envelope('m-2', 'second')]);
const retired = `[gugu_session session-direct]\norigin=${JSON.stringify({
  source: 'session-direct', kind: 'message', sender_session_id: 's-parent', message_id: 'm-1',
})}\nDelegate this.`;

describe('#6823 stored startup text without an origin', () => {
  it('the batch fixture is a <gugu_deliveries> frame', () => {
    expect(batch).toMatch(/^<gugu_deliveries[\s>]/);
  });

  it.each([
    ['one delivery envelope', envelope('m-1', 'first'), 'communication'],
    ['a <gugu_deliveries> batch', batch, 'communication'],
    ['the retired session-direct header', retired, 'communication'],
    ['words a person typed', 'make one task', 'manual'],
  ])('reads %s', (_shape, text, origin) => {
    expect(mapSessionRowToSession(storedRow({ initialQueue: [{ text }] })).initialQueue)
      .toEqual([{ text, origin }]);
  });

  it('the pre-initialQueue ACP payload gets the same reading', () => {
    expect(mapSessionRowToSession(storedRow({ initialPrompt: batch })).initialQueue)
      .toEqual([{ text: batch, origin: 'communication' }]);
  });

  it('an origin the producer wrote is kept as written, whatever the text looks like', () => {
    const text = envelope('m-1', 'relayed verbatim');
    expect(mapSessionRowToSession(storedRow({ initialQueue: [{ text, origin: 'manual' }] })).initialQueue)
      .toEqual([{ text, origin: 'manual' }]);
  });
});
