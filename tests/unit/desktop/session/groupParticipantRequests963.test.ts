import { describe, expect, it } from 'vitest';
import { GroupParticipantRequests } from '@renderer/features/chats/group-participant-requests';

describe('group placement follows the authorized session notification', () => {
  it('only commits the latest click and consumes stale events without navigating to an empty task', () => {
    const requests = new GroupParticipantRequests();
    const a = { projectId: 'p', sessionId: 'a' };
    const b = { projectId: 'p', sessionId: 'b' };
    requests.prepare('group', a);
    requests.prepare('group', b);
    expect(requests.take(a)).toEqual({});
    expect(requests.take(b)).toMatchObject({ sourceChatId: 'group' });
    expect(requests.take(b)).toBeUndefined();
  });

  it('cancels a failed lookup or account switch without turning a late focus event into normal navigation', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    requests.prepare('group', target)();
    expect(requests.take(target)).toEqual({});
    expect(requests.take({ ...target, sessionId: 'unrelated' })).toBeUndefined();
  });

  it('does not let an already received notification steal the pane after a newer click', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    requests.prepare('group', target);
    const ready = requests.take(target);
    requests.prepare('group', { ...target, sessionId: 'b' });
    expect(ready?.isCurrent?.()).toBe(false);
  });

  it('invalidates all in-flight notifications at the account boundary', () => {
    const requests = new GroupParticipantRequests();
    const first = { projectId: 'p', sessionId: 'a' };
    const second = { projectId: 'p', sessionId: 'b' };
    requests.prepare('group', first);
    const received = requests.take(first);
    requests.prepare('group', second);
    requests.cancelAll();
    expect(received?.isCurrent?.()).toBe(false);
    expect(requests.take(second)).toEqual({});
  });
});
