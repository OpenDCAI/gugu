import { MessageListSkeleton } from '@/components/chat/MessageListSkeleton';

/** Loading belongs to the transcript's content overlay, below the composer. */
export function SessionChatLoading({ label, stage }: { label: string; stage?: string }) {
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
