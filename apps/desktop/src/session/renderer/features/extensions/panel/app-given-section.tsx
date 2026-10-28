import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight } from '@/lib/icons';
import { AppPlacesEditor, AppPlacesSummary } from '@/components/extensionBundle/AppPlaces';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import type { EnablePlace } from '@shared/extensions/host-actions';
import type { PlaceChange } from '@shared/extensions/app-places';
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
  blocked,
}: {
  extensionId: string;
  api: Pick<ExtensionsApi, 'appPlaces' | 'changeAppPlaces'>;
  /** Another machine's App page: its agents, named as that machine's (not 「这台电脑」「本机」). */
  machineName?: string;
  /**
   * Architecture I5: what this computer's switch says before any place does — switched off, or `agents:tools` taken back.
   * Then no agent gets its tools whoever it is given to, and the summary says that, never 「给了：…」.
   */
  blocked?: 'off' | 'revoked';
}) {
  const { translate } = useSessionMessages();
  const [places, setPlaces] = useState<EnablePlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await api.appPlaces({ extensionId });
      if (!result.success) throw result.error;
      setPlaces(result.data);
      setFailed('');
    } catch (error) { rendererLogger('actions/app-given-section').error({ error }, 'action failed'); setFailed(messageForUser(error)); }
  }, [api, extensionId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!places && !failed) return null;
  const change = async (changes: readonly PlaceChange[]) => {
    setBusy(true);
    try {
      // Each change on its own (architecture I9): what another computer changed meanwhile is never written over.
      const result = await api.changeAppPlaces({ extensionId, changes: [...changes] });
      if (!result.success) throw result.error;
      await load();
    } catch (error) {
      rendererLogger('actions/app-given-section').error({ error }, 'action failed'); setFailed(messageForUser(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    {failed && <p role="alert" className="text-sm text-foreground-destructive">
      {failed} <button type="button" className="xp-link" onClick={() => void load()}>{translate('extensions.retry')}</button>
    </p>}
    {places &&
    // Read again when opened: the person may have changed it from another computer, or an install chose it since.
    <Collapsible className="xp-row-details" data-testid={`extension-given-${extensionId}`} onOpenChange={(open) => { if (open) void load(); }}>
      <CollapsibleTrigger className="xp-row-details-toggle">
        <ChevronRight className="size-3" />
        {blocked
          ? <span data-testid="extension-given-blocked">{translate(blocked === 'off' ? 'extensions.givenBlockedOff' : 'extensions.givenBlockedRevoked')}</span>
          : <AppPlacesSummary places={places} machineName={machineName} />}
      </CollapsibleTrigger>
      <CollapsibleContent className="xp-row-details-body">
        <AppPlacesEditor places={places} machineName={machineName} enabled={new Set((places ?? []).filter((place) => place.enabled).map((place) => place.id))} onChange={(changes) => void change(changes)} disabled={busy} />
      </CollapsibleContent>
    </Collapsible>}
    </>
  );
}
