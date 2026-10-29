import { describe, expect, expectTypeOf, it } from 'vitest';
import { AcpTranscriptParser, type AcpTranscriptParserDeps } from '../reducer/parser';
import { decodeSessionUpdate } from './decode';

describe('parser transport boundary', () => {
  it('accepts domain events from ingress and replays the same domain vocabulary', () => {
    const event = decodeSessionUpdate({ sessionUpdate: 'agent_message_chunk', messageId: 'raw', content: { type: 'text', text: 'decoded once' } });
    const parser = new AcpTranscriptParser({ sessionId: 'boundary' });
    parser.pushEvent(event, 10);
    parser.endTurn(11);
    expect(AcpTranscriptParser.replay([{ event, at: 10 }], { sessionId: 'boundary' }).committed)
      .toMatchObject([{ items: [{ text: 'decoded once' }] }]);
    expect(parser.history[0]?.items).toMatchObject([{ text: 'decoded once' }]);
    expectTypeOf(parser).not.toHaveProperty('push');
    expectTypeOf<AcpTranscriptParserDeps>().not.toHaveProperty('enrich');
  });

  it('does not change state when ingress decoding fails', () => {
    const parser = new AcpTranscriptParser({ sessionId: 'boundary' });
    parser.pushEvent({ kind: 'message', role: 'assistant', messageId: 'prior', text: 'kept' }, 10);
    const prior = parser.snapshotState();
    expect(() => parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'broken', locations: [{ path: '' }] }), 11))
      .toThrow('ACP tool location path must not be empty');
    expect(parser.snapshotState()).toBe(prior);
  });
});
