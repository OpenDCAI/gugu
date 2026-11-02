import { useCallback, useId } from 'react';
import { OFFLINE_SESSION_SLOT_PREFIX, readShellSlots } from '@/lib/shellSlots';
import '@/mobile/agent-watch/agent-watch.css';
import '@/mobile/agent-watch/phone-conversation.css';
import '@/components/assistant/assistant-task-chat.css';

/** The shell owns the page's Devices/Chat/Auth contexts; the embedded gate owns its placement. */
export function OfflineSessionSlot({ sessionId }: { sessionId: string }) {
  const id = useId();
  const key = `${OFFLINE_SESSION_SLOT_PREFIX}${sessionId}/${id}`;
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(key, element), [key]);
  return <div ref={ref} data-offline-session={sessionId} className="flex h-full min-h-0 w-full flex-col" />;
}
