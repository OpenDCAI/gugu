import { useSyncExternalStore } from 'react';
import { senderAvatarUrl, subscribeSenderAvatars } from '@renderer/lib/chat/sender-avatar';

/** Scheduled agents use the same identity and avatar as their conversation. */
export function AutomationAgentAvatar({ sessionId }: { sessionId: string | undefined }) {
  const url = useSyncExternalStore(
    subscribeSenderAvatars,
    () => sessionId ? senderAvatarUrl(`session:${sessionId}`) : null,
    () => null,
  );
  return url ? <img src={url} alt="" className="size-4 shrink-0 rounded-full object-cover" /> : null;
}
