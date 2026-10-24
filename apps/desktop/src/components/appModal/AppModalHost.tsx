import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sheet } from '../ui/Sheet';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { createModal, type BaseModalProps } from '../ui/modal-registry';
import { listenAppModals, type AppModalPresentation } from './appModal';
import type { BrowserWebviewElement } from '@/session/renderer/features/browser/browser-webview-types';
import { XIcon } from '@/lib/icons';

const widths = { xs: '320px', sm: '384px', md: '512px', lg: '672px', xl: '896px' };
const appModalRegistry = { page: createModal(AppModalSheet) };

/** One window-level host for every App. Its guests retain their App's existing sandbox. */
export function AppModalHost() {
  const [dialogs, setDialogs] = useState<AppModalPresentation[]>([]);
  const active = useRef(dialogs);
  active.current = dialogs;
  useEffect(() => {
    const stop = listenAppModals((event) => {
      if (event.type === 'open') setDialogs((current) => [...current, event.presentation]);
      else if (event.type === 'close') setDialogs((current) => current.filter((modal) => modal.id !== event.id));
      else [...document.querySelectorAll<HTMLElement>('[data-app-modal-id]')].find((element) => element.dataset.appModalId === event.id)?.querySelector<HTMLButtonElement>('[data-app-modal-close]')?.focus();
    });
    return () => { stop(); for (const modal of active.current) void modal.dismiss(); };
  }, []);
  const Component = appModalRegistry.page.component;
  return <>{dialogs.map((presentation) => <Component key={presentation.id} presentation={presentation} onClose={() => void presentation.dismiss()} onSuccess={() => void presentation.dismiss()} />)}</>;
}

function AppModalSheet({ presentation: modal, onClose }: { presentation: AppModalPresentation } & BaseModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  // A Dialog portal may mount after its owner committed: bind at the guest's actual mount, not an earlier effect.
  const attach = useCallback((element: BrowserWebviewElement | HTMLIFrameElement | null) => element ? modal.attach(element) : undefined, [modal]);
  const focus = (edge: 'first' | 'last') => void modal.focus(edge);
  return (
    <Sheet onClose={onClose} desktopWidth={widths[modal.size]} desktopHeight="min(560px, calc(100dvh - 32px))" desktopMaxHeight="calc(100dvh - 32px)" fullScreenMobile finalFocus={() => modal.opener.isConnected ? modal.opener : false} titleId={titleId} testId="app-modal">
      <div className="flex min-h-0 flex-1 flex-col" data-app-modal-id={modal.id}>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] !px-5 !py-3">
          <div className="min-w-0"><p className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{modal.appName}</p><Dialog.Title id={titleId} className="text-[length:var(--font-title)] font-medium">{modal.title}</Dialog.Title></div>
          <Button type="button" variant="ghost" size="icon" data-app-modal-close aria-label={t('dialog.close')} onClick={onClose} className="shrink-0"><XIcon className="size-4" /></Button>
        </header>
        <span tabIndex={0} className="h-0 overflow-hidden" onFocus={() => focus('first')} />
        {modal.partition ? <webview ref={attach} src={modal.url} partition={modal.partition} className="min-h-0 w-full flex-1" /> : <iframe ref={attach} name={modal.frameName} title={modal.title} src={modal.url} sandbox="allow-scripts allow-same-origin allow-forms" className="min-h-0 w-full flex-1 border-0" />}
        <span tabIndex={0} className="h-0 overflow-hidden" onFocus={() => focus('last')} />
      </div>
    </Sheet>
  );
}
