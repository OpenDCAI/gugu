import React, { useCallback } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SettingsRow } from '@/components/settings/SettingsPrimitives';

const ResourceMonitorSettingsCard: React.FC = () => {
  const {
    value: resourceMonitor,
    update,
    isLoading: loading,
    isSaving: saving,
  } = useAppSettingsKey('resourceMonitor');
  const { translate } = useSessionMessages();

  const enabled = resourceMonitor?.enabled ?? false;

  const toggle = useCallback(
    (next: boolean) => {
      update({ enabled: next });
    },
    [update]
  );

  return (
    <SettingsRow
      title={translate('resourceMonitor.title')}
      description={translate('resourceMonitor.description')}
      control={<Switch checked={enabled} disabled={loading || saving} onCheckedChange={toggle} />}
    />
  );
};

export default ResourceMonitorSettingsCard;
