import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import { groupParticipantPanes } from './group-participant-panes';
import { groupParticipantRequests } from './group-participant-requests';

/** Placement preferences and pending opens belong to the signed-in person. */
export function wireGroupParticipantAccount(): () => void {
  const identity = readSelfIdentityBridge();
  let current: string | null | undefined;
  const sync = () => {
    const accountId = identity?.getSnapshot()?.userId ?? null;
    if (accountId === current) return;
    current = accountId;
    groupParticipantRequests.cancelAll();
    groupParticipantPanes.useAccount(accountId);
  };
  sync();
  return identity?.subscribe(sync) ?? (() => {});
}
