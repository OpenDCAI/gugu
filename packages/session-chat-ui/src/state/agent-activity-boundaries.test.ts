import { describe, expect, it } from 'vitest';
import type { RenderUnit } from '../core/units';
import { appendActivityUnits, foldActivityUnits, trailingActivity, type AgentActivityEvent, type AgentActivityGroup } from './agent-activity';
import { joinedActivityLanes, activityLanes } from './activity-lanes';

const row = (id: string, kind = 'message'): RenderUnit => ({ id, itemId: id, groupId: id, kind, groupRole: 'solo', gapBefore: 0,
  data: { kind: 'message', id, role: 'user', text: id } });
const activity = (id: string, actor = id): RenderUnit => ({ ...row(id), activityEvent: { id, direction: 'received', count: 1, live: false,
  actors: [{ id: `user:${actor}`, name: actor, target: { kind: 'sender', userId: actor } }] } satisfies AgentActivityEvent });
const group = (rows: readonly RenderUnit[]) => rows.find(unit => unit.kind === 'agent-activity')!.data as AgentActivityGroup;

describe('activity visibility boundaries', () => {
  it('keeps different actors and hover-only actions in one chronological group', () => {
    const rows = foldActivityUnits([activity('one', 'a'), row('copy-one', 'turn-completion'), activity('two', 'b'), row('copy-two', 'turn-completion'), activity('three', 'c')]);
    expect(rows.filter(unit => unit.kind === 'agent-activity')).toHaveLength(1);
    expect(group(rows).events.map(event => event.actors[0].id)).toEqual(['user:a', 'user:b', 'user:c']);
    expect(group(rows).messageIds).toEqual(['one', 'two', 'three']);
    expect(rows.slice(1).every(unit => unit.activityFold === rows[0].id)).toBe(true);
  });
  it.each(['message', 'file-change-summary', 'opened-output', 'turn-outcome', 'turn-process', 'day-separator'])('preserves a visible %s boundary', kind => {
    const boundary = row('visible', kind);
    const rows = foldActivityUnits([activity('one'), boundary, activity('two')]);
    expect(rows.filter(unit => unit.kind === 'agent-activity')).toHaveLength(2);
    expect(rows.find(unit => unit.id === boundary.id)).toBe(boundary);
    expect(boundary.activityFold).toBeUndefined();
  });
  it('extends the same committed header through copy metadata in the active tier without recounting', () => {
    const prefix = foldActivityUnits([activity('one'), row('copy-one', 'turn-completion')]);
    const tail = foldActivityUnits([row('copy-two', 'turn-completion'), activity('two', 'b')], trailingActivity(prefix));
    const joined = appendActivityUnits(prefix, tail);
    expect(joined.filter(unit => unit.kind === 'agent-activity')).toHaveLength(1);
    expect(group(joined).events.map(event => event.id)).toEqual(['one', 'two']);
    expect(joinedActivityLanes(activityLanes(prefix), tail, prefix.length)).toEqual([{ index: 0, end: joined.length, id: prefix[0].id }]);
  });
});
