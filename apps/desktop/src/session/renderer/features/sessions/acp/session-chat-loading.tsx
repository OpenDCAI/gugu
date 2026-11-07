import { useContext } from 'react';
import { MessageListSkeleton } from '@/components/chat/MessageListSkeleton';
import { TabLayerShownContext } from '@renderer/features/tabs/retained-tab-content';

/**
 * Loading belongs to the transcript's content overlay, below the composer. A tab layer kept hidden draws none: a chat tab
 * not in front has no store here, so its skeleton would stay, and CSS animations run on under content-visibility:hidden.
 */
export function SessionChatLoading({ label, stage }: { label: string; stage?: string }) {
  const shown = useContext(TabLayerShownContext);
  if (!shown) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 flex flex-col bg-background-secondary-1"
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-busy="true"
      data-testid="acp-chat-history-loading"
      data-life-stage={stage}
    >
      <MessageListSkeleton />
    </div>
  );
}
