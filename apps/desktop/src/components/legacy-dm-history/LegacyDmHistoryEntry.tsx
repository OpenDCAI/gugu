import { lazy, Suspense, useState } from 'react';
import { Button } from '@/session/renderer/lib/ui/button';
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages';

// Session menus load without IM, auth or attachment preview modules. Fetch those only on demand.
const HistoryDialog = lazy(() => import('./LegacyDmHistory').then(module => ({ default: module.LegacyDmHistoryDialog })));

export function LegacyDmHistoryDialog({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  return <Suspense fallback={null}><HistoryDialog sessionId={sessionId} onClose={onClose} /></Suspense>;
}

/** A separate archive; opening it never selects a chat or a native session. */
export function LegacyDmArchiveButton() {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);
  return <>
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>{translate('legacyDm.archive')}</Button>
    {open && <LegacyDmHistoryDialog onClose={() => setOpen(false)} />}
  </>;
}
