// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { publishSelfIdentity } from '@/lib/selfIdentityBridge';
import { wireGroupParticipantAccount } from '@renderer/features/chats/group-participant-account';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';
import { groupParticipantRequests } from '@renderer/features/chats/group-participant-requests';

it('switches preference scopes and consumes late opens when the shell account changes', () => {
  const identity = (userId: string) => ({ userId, displayName: userId, guguNumber: null });
  publishSelfIdentity(identity('account-first'));
  const dispose = wireGroupParticipantAccount();
  const target = { projectId: 'p', sessionId: 's' };
  try {
    groupParticipantPanes.rememberWidth(610);
    const request = groupParticipantRequests.prepare('group', target);
    publishSelfIdentity(identity('account-second'));
    expect(groupParticipantPanes.rightWidth).toBe(480);
    expect(groupParticipantRequests.take(target, request.requestId)).toEqual({});
    expect(groupParticipantRequests.take(target)).toBeUndefined();
    groupParticipantPanes.rememberWidth(420);
    publishSelfIdentity(identity('account-first'));
    expect(groupParticipantPanes.rightWidth).toBe(610);
    publishSelfIdentity(null);
    expect(groupParticipantPanes.placements.size).toBe(0);
  } finally {
    dispose();
    publishSelfIdentity(null);
  }
});
