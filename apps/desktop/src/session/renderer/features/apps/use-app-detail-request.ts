import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { messageForUser } from '@/lib/userFacingError';
import type { ExtensionsHost } from '@renderer/features/extensions/extensions-host';
import type { ExtensionDetailSubject } from '@renderer/features/extensions/panel/app-product-page';
import { toast } from '@renderer/lib/hooks/use-toast';

/** Navigation opens a detail once; background market refreshes do not reopen a page the person left. */
export function useAppDetailRequest({ target, ready, host, setDetail, detail, rootRef }: {
  target?: AppDetailLink; ready: boolean; host: ExtensionsHost;
  setDetail: Dispatch<SetStateAction<ExtensionDetailSubject | null>>; detail: ExtensionDetailSubject | null;
  rootRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    if (!target || !ready) return;
    let cancelled = false;
    const open = async () => {
      const installed = target.deviceId ? host.store.manifests.find((row) => row.id === target.extensionId) : undefined;
      if (target.deviceId && !installed) throw new Error('The installed App is no longer available on this device.');
      const result = await host.api.marketEntry({ extensionId: target.extensionId });
      if (cancelled) return;
      const item = result.success ? result.data : undefined;
      if (!item && !installed) throw new Error(result.error ?? 'This App is no longer in the market.');
      setDetail({ manifest: item?.manifest ?? installed!, installed, cloud: item?.cloud ?? null, installRef: item?.ref });
    };
    void open().catch((error: unknown) => { if (!cancelled) toast({ title: messageForUser(error), variant: 'destructive' }); });
    return () => { cancelled = true; };
  }, [target, ready, host, setDetail]);
  const variants = target ? host.store.variants[target.extensionId] : undefined;
  useEffect(() => {
    if (target?.variant && detail?.manifest.id === target.extensionId) {
      rootRef.current?.querySelector(`[data-testid="app-variant-${target.variant}"]`)?.scrollIntoView({ block: 'center' });
    }
  }, [target, detail, variants, rootRef]);
}
