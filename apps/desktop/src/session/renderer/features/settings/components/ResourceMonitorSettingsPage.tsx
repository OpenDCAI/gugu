import { useEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { SettingsNote, SettingsPage, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { Switch } from '@/components/ui/Switch';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { appState } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { openResourcePopup } from './resource-monitor-host';
import { ResourceTimeline } from './resource-timeline';

export const ResourceMonitorSettingsPage = observer(function ResourceMonitorSettingsPage() {
  const { value, update, isLoading, isSaving } = useAppSettingsKey('resourceMonitor');
  const { translate } = useSessionMessages();
  const enabled = value?.enabled ?? false;
  const store = appState.resourceMonitor;

  useEffect(() => {
    if (!enabled) return;
    const release = store.watch();
    return () => { void store.setInternals(false); release(); };
  }, [enabled, store]);

  return (
    <SettingsPage>
      <SettingsRow
        title={translate('resourceMonitor.enabled')}
        description={translate('resourceMonitor.description')}
        control={<Switch aria-label={translate('resourceMonitor.enabled')} checked={enabled} disabled={isLoading || isSaving} onCheckedChange={(next) => update({ enabled: next })} />}
      />
      {!enabled && <SettingsNote>{translate('resourceMonitor.off')}</SettingsNote>}
      <ResourceTimeline live={enabled} onFloat={enabled ? openResourcePopup : undefined} />
    </SettingsPage>
  );
});
