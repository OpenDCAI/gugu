import type { ScreenSession } from '@renderer/app/screen-layout';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { showGroupParticipant } from './group-participant-actions';
import { groupParticipantRequests } from './group-participant-requests';

/** Undefined leaves ordinary focus notifications alone; a consumed stale request never navigates. */
export function openRequestedGroupParticipant(target: ScreenSession, requestId?: string): (() => void) | undefined {
  const request = groupParticipantRequests.take(target, requestId);
  if (!request) return;
  if (!request.sourceChatId) return () => {};
  const sourceChatId = request.sourceChatId;
  return openSessionInSessionWhenReady({
    ...target,
    onlyIfNoTabs: true,
    onReady: () => {
      if (request.isCurrent?.()) showGroupParticipant(sourceChatId, { kind: 'session', ...target });
    },
  });
}
