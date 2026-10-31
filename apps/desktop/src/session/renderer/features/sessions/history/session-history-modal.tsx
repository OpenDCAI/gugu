import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SessionHistoryView } from './session-history-view';

/** Archived history has no live task workspace. Reading it must not restore or provision one. */
export function SessionHistoryModal({ sessionId, title }: BaseModalProps<void> & { sessionId: string; title: string }) {
  const { translate } = useSessionMessages();
  return <>
    <DialogHeader><DialogTitle>{title} · {translate('globalSearch.archived')}</DialogTitle></DialogHeader>
    <div className="h-[min(640px,75vh)] min-h-0"><SessionHistoryView key={sessionId} sessionId={sessionId} /></div>
  </>;
}
