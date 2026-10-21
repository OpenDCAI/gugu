import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from '@/lib/icons';
import { AppPlacesEditor, AppPlacesSummary } from '@/components/extensionBundle/AppPlaces';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import type { EnablePlace } from '@shared/extensions/host-actions';
import { applyPlaceChanges, type PlaceChange } from '@shared/extensions/app-places';
import type { ExtensionsApi } from '../extensions-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * D-30 「给哪些 agent」 on an App's row in 「App」 (app-given.ts `appPlaces`): this computer's agents, all of them (kept with
 * the install), then the person's own agents and groups (kept by the server for the account). Its tools
 * reach the agents chosen at once (a running session at its next call); an App nobody chose for reaches every agent here, and says so.
 * 方案 A: folded, one line saying to whom (`AppPlacesSummary`); open, the install sheet's own editor.
 */
export function AppGivenSection({
  extensionId,
  api,
  machineName,
}: {
  extensionId: string;
  api: Pick<ExtensionsApi, 'appPlaces' | 'setAppPlaces'>;
  /** Another machine's App page: its agents, named as that machine's (not 「这台电脑」「本机」). */
  machineName?: string;
}) {
  const { translate } = useSessionMessages();
  const [places, setPlaces] = useState<EnablePlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const result = await api.appPlaces({ extensionId });
      if (!result.success) { setFailed(true); return; }
      setPlaces(result.data);
      setFailed(false);
    } catch { setFailed(true); }
  }, [api, extensionId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!places && !failed) return null;
  const enabled = (places ?? []).filter((place) => place.enabled).map((place) => place.id);
  const change = async (changes: readonly PlaceChange[]) => {
    setBusy(true);
    try {
      const result = await api.setAppPlaces({ extensionId, enableIn: applyPlaceChanges(enabled, changes) });
      if (!result.success) { setFailed(true); return; }
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    {failed && <p role="alert" className="text-sm text-foreground-destructive">
      {translate('appSettings.scopeFailed')} <button type="button" className="xp-link" onClick={() => void load()}>{translate('extensions.retry')}</button>
    </p>}
    {places &&
    // Read again when opened: the person may have changed it from another computer, or an install chose it since.
    <Collapsible className="xp-row-details" data-testid={`extension-given-${extensionId}`} onOpenChange={(open) => { if (open) void load(); }}>
      <CollapsibleTrigger className="xp-row-details-toggle">
        <ChevronRight className="size-3" />
        <AppPlacesSummary places={places} machineName={machineName} />
      </CollapsibleTrigger>
      <CollapsibleContent className="xp-row-details-body">
        <AppPlacesEditor places={places} machineName={machineName} enabled={new Set(enabled)} onChange={(changes) => void change(changes)} disabled={busy} />
      </CollapsibleContent>
    </Collapsible>}
    </>
  );
}
