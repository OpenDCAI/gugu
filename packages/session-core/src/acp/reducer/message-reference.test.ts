import { describe, expect, it, vi } from 'vitest';
import { AcpTranscriptParser } from './parser';
import { transcriptTurnSchema } from '../models/turns';

describe('live message reference identity', () => {
  it('mints a turn reference once, retains it through updates and commit, and changes it after reset', () => {
    const newTurnReference = vi.fn().mockReturnValueOnce('source:first').mockReturnValueOnce('source:second');
    const parser = new AcpTranscriptParser({ sessionId: 's', newTurnReference });
    parser.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'same' } }, 1);
    expect(parser.activeTurn).toHaveProperty('referenceId', 'source:first');
    parser.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } }, 2);
    expect(newTurnReference).toHaveBeenCalledTimes(1);
    parser.endTurn(3);
    expect(transcriptTurnSchema.parse(JSON.parse(JSON.stringify(parser.history[0])))).toHaveProperty('referenceId', 'source:first');
    const previousDisplayId = parser.history[0]!.id;
    parser.reset();
    parser.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'same' } }, 4);
    expect(parser.activeTurn!.id).toBe(previousDisplayId);
    expect(parser.activeTurn).toHaveProperty('referenceId', 'source:second');
  });
});
