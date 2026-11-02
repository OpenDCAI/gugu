import { describe, expect, it } from 'vitest';
import { alignSessionProjectReferences } from './session-project-references';

const locations = [{ conversationId: 'assistant', projectId: 'tasks' }, { conversationId: 'child', projectId: 'tasks' }];
describe('saved session project references', () => {
  it('keeps the same last task and multi-pane layout when its project registration changes', () => {
    const before = {
      navigation: { currentViewId: 'session', viewParams: { session: { sessionId: 'assistant', projectId: 'old' }, assistant: { tab: 'today' } } },
      screen: { layout: { pane: 'first' }, focused: 'first', blocks: { first: { kind: 'session', sessionId: 'assistant', projectId: 'old' } },
        parked: [{ blocks: { child: { kind: 'session', sessionId: 'child', projectId: 'old' } } }] },
    };
    const after = alignSessionProjectReferences(before, locations);
    expect(after.navigation.viewParams.session).toEqual({ sessionId: 'assistant', projectId: 'tasks' });
    expect(after.navigation.viewParams.assistant).toBe(before.navigation.viewParams.assistant);
    expect(after.screen.blocks.first).toEqual({ kind: 'session', sessionId: 'assistant', projectId: 'tasks' });
    expect(after.screen.parked[0]?.blocks.child.projectId).toBe('tasks');
    expect(after.screen.layout).toBe(before.screen.layout);
    expect(before.navigation.viewParams.session.projectId).toBe('old');
    expect(alignSessionProjectReferences(after, locations)).toBe(after);
  });

  it('does not guess an unknown task, change a plain project view, or rewrite paths and message text', () => {
    const before = { project: { projectId: 'old' }, unknown: { sessionId: 'unknown', projectId: 'old' },
      session: { sessionId: 'assistant', projectId: 'old', path: '/old', message: 'old' } };
    const after = alignSessionProjectReferences(before, locations);
    expect(after.project).toBe(before.project);
    expect(after.unknown).toBe(before.unknown);
    expect(after.session).toEqual({ sessionId: 'assistant', projectId: 'tasks', path: '/old', message: 'old' });
  });

  it('uses the current machine-qualified project IDs supplied by that machine’s directory', () => {
    const before = [{ sessionId: 'remote-assistant', projectId: 'remote:old' }, { sessionId: 'local-task', projectId: 'local-project' }];
    const after = alignSessionProjectReferences(before, [{ conversationId: 'remote-assistant', projectId: 'remote:tasks' }]);
    expect(after[0]?.projectId).toBe('remote:tasks');
    expect(after[1]).toBe(before[1]);
  });

  it('leaves absent snapshots and already-correct ordinary task destinations unchanged', () => {
    expect(alignSessionProjectReferences(null, locations)).toBeNull();
    expect(alignSessionProjectReferences(undefined, locations)).toBeUndefined();
    const normal = { sessionId: 'ordinary', projectId: 'my-project' };
    expect(alignSessionProjectReferences(normal, [{ conversationId: 'ordinary', projectId: 'my-project' }])).toBe(normal);
  });
});
