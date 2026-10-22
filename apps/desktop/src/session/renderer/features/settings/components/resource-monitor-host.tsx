import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { desktopIpc } from '@/platform/desktopIpc';
import { mirrorDocument } from '@renderer/lib/aux-document';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { auxWindows } from '@renderer/app/aux-windows';
import { RESOURCE_CONTEXT_REQUEST, type ResourceUiContext } from '@shared/resource-monitor';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { toast } from '@renderer/lib/hooks/use-toast';
const ResourceTimeline = lazy(() => import('./resource-timeline').then((m) => ({ default: m.ResourceTimeline })));

export const RESOURCE_WINDOW_NAME = 'gugu-aux:resource-monitor';
let showPopup: (() => void) | null = null;
export function openResourcePopup(): void { showPopup?.(); }

/** One host in the shell: leaving Settings does not unmount a floating monitor. No pre-created window. */
export function ResourceMonitorHost({ tab, settings }: { tab: string; settings: string | null }) {
  const shell = useRef({ tab, settings });
  shell.current = { tab, settings };
  const [popup, setPopup] = useState<Window | null>(null);
  useEffect(() => {
    const ipc = desktopIpc();
    if (!ipc) return;
    return ipc.eventOn(RESOURCE_CONTEXT_REQUEST, (value) => {
      const id = (value as { id?: unknown })?.id;
      if (typeof id !== 'string') return;
      const opened = [...sessionRegistry.allSessions().values()];
      const navigation = appState.navigation;
      const params = navigation.viewParamsStore[navigation.currentViewId] as Record<string, unknown> | undefined;
      const context: ResourceUiContext = {
        observedAt: Date.now(), ...shell.current, view: navigation.currentViewId,
        openedTasks: opened.length,
        remoteOpenedTasks: opened.filter((s) => machineRegistry.machineOf(s.data.projectId) !== null).length,
        auxiliaryWindows: auxWindows.windows.size,
        ...Object.fromEntries(['projectId', 'sessionId', 'appId'].flatMap((key) => typeof params?.[key] === 'string' ? [[key, params[key]]] : [])),
      };
      void rpc.resourceMonitor.reportContext(id, context);
    });
  }, []);
  useEffect(() => {
    showPopup = () => {
      if (popup && !popup.closed) { popup.focus(); return; }
      const next = window.open('about:blank', RESOURCE_WINDOW_NAME, 'width=360,height=220');
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
