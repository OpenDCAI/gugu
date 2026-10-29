import { describe, expect, it } from 'vitest';
import { foldItem, type FoldEvent } from './item-fold';
import { toolNodeSchema } from '../models/turns/tool-calls';

const start: FoldEvent = { kind: 'tool_call', toolCallId: 'send', title: 'message_send', toolKind: 'other', status: 'pending', parentToolCallId: null, locations: [] };
const done: FoldEvent = { kind: 'tool_update', toolCallId: 'send', title: null, toolKind: null, status: 'completed', parentToolCallId: null };

describe('authentic tool boundary clocks', () => {
  it('does not stamp a replayed hook notice with the replay clock', () => {
    const notice: FoldEvent = { kind: 'session_notice', code: 'provider-notice', title: 'Stop says: Check.', detail: 'Stop says: Check.' };
    expect(foldItem([], notice, 't', 200)[0]).not.toHaveProperty('at');
    expect(foldItem([], notice, 't', 200, 2000)[0]).toMatchObject({ at: 2000 });
  });
  it('retains arrival and first completion across later updates', () => {
    const running = foldItem([], start, 't', 100, 1000);
    expect(running[0]).toMatchObject({ at: 1000 });
    const complete = foldItem(running, done, 't', 200, 2000);
    expect(complete[0]).toMatchObject({ at: 1000, completedAt: 2000 });
    expect(foldItem(complete, done, 't', 300, 3000)[0]).toMatchObject({ at: 1000, completedAt: 2000 });
  });
  it('does not stamp replay arrival or completion with the replay clock', () => {
    const replayed = foldItem(foldItem([], start, 't', 100), done, 't', 200);
    expect(replayed[0]).not.toHaveProperty('at');
    expect(replayed[0]).not.toHaveProperty('completedAt');
  });
  it('preserves the clocks across persisted and transported tool validation', () => {
    const complete = foldItem(foldItem([], start, 't', 100, 1000), done, 't', 200, 2000);
    expect(toolNodeSchema.parse(JSON.parse(JSON.stringify(complete[0])))).toMatchObject({ at: 1000, completedAt: 2000 });
  });
});
