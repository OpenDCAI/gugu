import { describe, expect, it } from 'vitest';
import { GroupParticipantRequests } from '@renderer/features/chats/group-participant-requests';

describe('group placement follows the authorized session notification', () => {
  it('only commits the latest click and consumes stale events without navigating to an empty task', () => {
    const requests = new GroupParticipantRequests();
    const a = { projectId: 'p', sessionId: 'a' };
    const b = { projectId: 'p', sessionId: 'b' };
    const first = requests.prepare('group', a);
    const second = requests.prepare('group', b);
    expect(requests.take(a, first.requestId)).toEqual({});
    expect(requests.take(b, second.requestId)).toMatchObject({ sourceChatId: 'group' });
    expect(requests.take(b)).toBeUndefined();
  });

  it('cancels a failed lookup or account switch without turning a late focus event into normal navigation', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    const cancel = requests.prepare('group', target);
    cancel();
    expect(requests.take(target)).toBeUndefined();
    expect(requests.take(target, cancel.requestId)).toEqual({});
    expect(requests.take({ ...target, sessionId: 'unrelated' })).toBeUndefined();
  });

  it('does not let an already received notification steal the pane after a newer click', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    const request = requests.prepare('group', target);
    const ready = requests.take(target, request.requestId);
    requests.prepare('group', { ...target, sessionId: 'b' });
    expect(ready?.isCurrent?.()).toBe(false);
  });

  it('invalidates all in-flight notifications at the account boundary', () => {
    const requests = new GroupParticipantRequests();
    const first = { projectId: 'p', sessionId: 'a' };
    const second = { projectId: 'p', sessionId: 'b' };
    const firstRequest = requests.prepare('group', first);
    const received = requests.take(first, firstRequest.requestId);
    const secondRequest = requests.prepare('group', second);
    requests.cancelAll();
    expect(received?.isCurrent?.()).toBe(false);
    expect(requests.take(second)).toBeUndefined();
    expect(requests.take(second, secondRequest.requestId)).toEqual({});
  });

  it('leaves newer ordinary focus alone and invalidates the older group placement', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    const request = requests.prepare('group', target);
    expect(requests.take(target)).toBeUndefined();
    expect(requests.take(target, request.requestId)).toEqual({});
  });

  it('does not let a cancelled receipt or cancellation consume the next request for the same session', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    const first = requests.prepare('first-group', target);
    first();
    const second = requests.prepare('second-group', target);
    first();
    expect(requests.take(target, first.requestId)).toEqual({});
    expect(requests.take(target, second.requestId)).toMatchObject({ sourceChatId: 'second-group' });
  });

  it('does not mistake a different session for the matching request receipt', () => {
    const requests = new GroupParticipantRequests();
    const target = { projectId: 'p', sessionId: 'a' };
    const request = requests.prepare('group', target);
    expect(requests.take({ ...target, sessionId: 'b' }, request.requestId)).toEqual({});
    expect(requests.take({ ...target, projectId: 'imported-alias' }, request.requestId)).toMatchObject({ sourceChatId: 'group' });
  });
});
