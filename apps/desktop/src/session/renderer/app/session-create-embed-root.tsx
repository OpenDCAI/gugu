import { useCallback } from 'react';
import { NewSessionPage } from '@renderer/features/sessions/new-session-page';

type SessionCreatedResult = { projectId: string; sessionId: string };

export function SessionCreateEmbedRoot() {
  const notifyHost = useCallback((result: SessionCreatedResult) => {
    const host = (window as unknown as {
      __GUGU_SESSION_CREATED__?: (created: SessionCreatedResult) => void;
    }).__GUGU_SESSION_CREATED__;
    if (!host) throw new Error('session creation host bridge is unavailable');
    host(result);
  }, []);

  return (
    <div data-testid="mobile-session-create-embed" className="h-full min-h-0">
      <NewSessionPage onSessionCreated={notifyHost} />
    </div>
  );
}
