import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { appState } from '@renderer/lib/stores/app-state';
import { RESOURCE_MONITOR_WINDOW_NAME } from '@shared/resource-monitor';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { toast } from '@renderer/lib/hooks/use-toast';
const ResourceTimeline = lazy(() => import('./resource-timeline').then((m) => ({ default: m.ResourceTimeline })));

let showPopup: (() => void) | null = null;
export function openResourcePopup(): void { showPopup?.(); }

/** One host in the shell: leaving Settings does not unmount a floating monitor. No pre-created window. */
export function ResourceMonitorHost() {
  const [popup, setPopup] = useState<Window | null>(null);
  useEffect(() => {
    showPopup = () => {
      if (popup && !popup.closed) { popup.focus(); return; }
      const next = window.open('about:blank', RESOURCE_MONITOR_WINDOW_NAME, 'width=360,height=220');
      if (!next) { toast({ title: translateSessionMessage('resourceMonitor.windowFailed'), tier: 'error' }); return; }
      next.document.title = translateSessionMessage('resourceMonitor.title');
      setPopup(next);
    };
    return () => { showPopup = null; };
  }, [popup]);
  useEffect(() => {
    if (!popup) return;
    const stopMirror = mirrorDocument(document, popup.document);
    const gone = () => setPopup(null);
    popup.addEventListener('pagehide', gone);
    const store = appState.resourceMonitor;
    const release = store.watch();
    return () => {
      popup.removeEventListener('pagehide', gone);
      stopMirror(); release();
      if (!popup.closed) popup.close();
    };
  }, [popup]);
  return popup ? createPortal(<div className="gugu-skin bg-background p-3 text-foreground" data-resource-popup=""><Suspense><ResourceTimeline compact /></Suspense></div>, popup.document.body) : null;
}
