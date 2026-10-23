import { describe, expect, it, vi } from 'vitest';
import type { NormalizedEvent } from '../reducer/normalized-event';
import { AcpTranscriptParser } from '../reducer/parser';

describe('parser transport boundary', () => {
  it('enriches a raw update once while already normalized events bypass the hook', () => {
    const enrich = vi.fn((event: NormalizedEvent) => event.kind === 'message' ? { ...event, text: `provider: ${event.text}`, content: [{ type: 'text', text: `provider: ${event.text}` }] } : event);
    const parser = new AcpTranscriptParser({ sessionId: 'boundary', enrich });
    const raw = { sessionUpdate: 'agent_message_chunk' as const, messageId: 'raw', content: { type: 'text' as const, text: 'raw' } };
    parser.push(raw, 10);
    parser.pushEvent({ kind: 'message', role: 'assistant', messageId: 'normalized', text: 'normalized' }, 11);
    expect(enrich).toHaveBeenCalledExactlyOnceWith({ kind: 'message', role: 'assistant', messageId: 'raw', text: 'raw', content: [raw.content], contentMode: 'append' }, raw);
    expect(parser.activeTurn?.items.map((item) => item.kind === 'message' ? item.text : null))
      .toEqual(['provider: raw', 'normalized']);
  });

  it('does not change state when raw decoding fails', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'boundary' });
    parser.pushEvent({ kind: 'message', role: 'assistant', messageId: 'prior', text: 'kept' }, 10);
    const prior = parser.snapshotState();
    expect(() => parser.push({ sessionUpdate: 'tool_call_update', toolCallId: 'broken', locations: [{ path: '' }] }, 11))
      .toThrow('ACP tool location path must not be empty');
    expect(parser.snapshotState()).toBe(prior);
  });

  it('does not change state when provider enrichment fails', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'boundary', enrich: () => { throw new Error('provider failed'); } });
    const prior = parser.snapshotState();
    expect(() => parser.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'raw' } }, 11))
      .toThrow('provider failed');
    expect(parser.snapshotState()).toBe(prior);
  });
});
