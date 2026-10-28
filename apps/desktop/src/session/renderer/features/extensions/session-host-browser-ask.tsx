import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PermissionBand } from '@gugu/session-ui/react/components';
import { BrowserAssistanceAction } from '@/components/browserUse/BrowserAssistanceAction';
import { messageForUser } from '@/lib/userFacingError';
import { rpcOn } from '@renderer/lib/ipc';
import { toast } from '@renderer/lib/hooks/use-toast';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { answeredTooLate } from './app-install-approval';
import { useSessionHostAsk } from './use-session-host-ask';

/**
 * The agent asks the person to log in or take one browser step for it (`browser-assistance`, the server's cloud browser)
 * — on its own session page, where Needs-you leaves a session that is on screen. The way to it first: this task's Browser
 * Use tab (the live browser, taking over, the password vault); then the ask's own answers, through the same `respond` on
 * the machine the session runs on. Read only while the session waits on it (`dialog`).
 */
export function SessionHostBrowserAsk({
  sessionId,
  session,
}: {
  sessionId: string | null;
  session: { status: string | null; detail: string | null } | null | undefined;
}) {
  const { t } = useTranslation('browserUse');
  const ask = useSessionHostAsk(session?.status === 'needs_user' && session.detail === 'dialog' ? sessionId : null, 'browser-assistance');
  const itemId = ask?.itemId;
  const resolve = useCallback(
    (optionId: string) => {
      if (!sessionId || !itemId) return;
      void rpcOn(machineRegistry.machineOf(sessionId))
        .sessionTimeline.sessionRespond({ conversationId: sessionId, itemId, kind: 'permission', optionId, by: 'desktop' })
        .then((result) => {
          if (answeredTooLate(result)) toast({ title: t('ask.noLongerWaiting') });
        })
        .catch((error: unknown) => {
          log.warn('Browser ask answer failed', { sessionId, error: error instanceof Error ? error.message : String(error) });
          toast({ title: messageForUser(error), variant: 'destructive' });
        });
    },
    [sessionId, itemId, t]
  );
  if (!sessionId || !ask || ask.origin?.source !== 'browser-assistance') return null;
  return (
    <div className="flex flex-col gap-1 px-2 pt-1" data-testid="session-host-browser-ask">
      <BrowserAssistanceAction sessionId={sessionId} settlement={ask} />
      <PermissionBand
        request={{
          requestId: ask.itemId,
          title: ask.title ?? '',
          options: (ask.options ?? []).map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind ?? '' })),
        }}
        onResolve={resolve}
      />
    </div>
  );
}
