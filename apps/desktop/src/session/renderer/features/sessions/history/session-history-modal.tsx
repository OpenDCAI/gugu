import { useState } from 'react';
import { messageForUser } from '@/lib/userFacingError';
import { toast } from '@renderer/lib/hooks/use-toast';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { restoreArchivedSession } from '../restore-session-flow';
import { StoredTranscriptView } from './stored-transcript-view';

/** Archived history has no live task workspace. Reading it must not restore or provision one. */
export function SessionHistoryModal({ projectId, sessionId, title, onSuccess }: BaseModalProps<void> & { projectId: string; sessionId: string; title: string }) {
  const { translate } = useSessionMessages();
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setRestoring(true);
    setError(null);
    try {
      await restoreArchivedSession({ projectId, sessionId });
      toast({ title: translate('sessionHistory.restoredToast') });
      onSuccess();
    } catch (failure) {
      log.error('restore archived session failed', { projectId, sessionId, error: String(failure) });
      setError(messageForUser(failure));
    } finally {
      setRestoring(false);
    }
  };
  return <>
    <DialogHeader><DialogTitle>{title} · {translate('globalSearch.archived')}</DialogTitle></DialogHeader>
    <div className="h-[min(640px,75vh)] min-h-0"><StoredTranscriptView key={sessionId} sessionId={sessionId} /></div>
    {error && <p role="alert" className="px-6 pb-3 text-xs text-foreground-destructive">{error}</p>}
    <DialogFooter>
      <Button disabled={restoring} onClick={() => void restore()}>{translate('sessionHistory.restore')}</Button>
    </DialogFooter>
  </>;
}
