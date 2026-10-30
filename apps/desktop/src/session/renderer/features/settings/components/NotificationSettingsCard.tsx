import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { events, rpc } from '@renderer/lib/ipc';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { extensionsInventoryChangedChannel } from '@shared/extensions/marketEvents';
import { localizedManifestText } from '@shared/extensions/catalog';
import { messageForUser } from '@/lib/userFacingError';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives';

const AppNotificationPermissions = observer(function AppNotificationPermissions() {
  const { translate } = useSessionMessages();
  const [revoked, setRevoked] = useState<Record<string, string[]> | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const [, result] = await Promise.all([installedExtensionsStore.load(), rpc.extensions.revoked()]);
        if (!result.success || !result.data) throw new Error(result.error);
        if (live) { setRevoked(result.data); setError(null); }
      } catch (cause) {
        if (live) { setRevoked(null); setError(messageForUser(cause)); }
      }
    };
    void refresh();
    const off = events.on(extensionsInventoryChangedChannel, () => { void refresh(); });
    return () => { live = false; off(); };
  }, []);

  const grant = async (extensionId: string, granted: boolean) => {
    setPending((now) => ({ ...now, [extensionId]: true }));
    try {
      // Same IPC as the App product page: the bridge reads this grant on every call.
      const result = await rpc.extensions.setPermissionGranted({ extensionId, permission: 'notifications', granted });
      if (!result.success || !result.data) throw new Error(result.error);
      const { revoked } = result.data;
      setRevoked((now) => ({ ...now, [extensionId]: revoked }));
      setError(null);
    } catch (cause) {
      setError(messageForUser(cause));
    } finally {
      setPending((now) => ({ ...now, [extensionId]: false }));
    }
  };
  const apps = installedExtensionsStore.manifests.filter((app) => app.permissions.capabilities.includes('notifications'));
  if (apps.length === 0 && !error) return null;
  return <SettingsGroup title={translate('notifications.apps')}>
    {apps.map((app) => {
      const name = localizedManifestText(app, installedExtensionsStore.locale).name;
      return <SettingsRow key={app.id} title={name} control={<Switch
        aria-label={name}
        checked={revoked !== null && !(revoked[app.id] ?? []).includes('notifications')}
        disabled={revoked === null || pending[app.id]}
        onCheckedChange={(checked) => { void grant(app.id, checked); }}
      />} />;
    })}
    {error && <SettingsNote tone="danger">{error}</SettingsNote>}
  </SettingsGroup>;
});

export default function NotificationSettingsCard() {
  const { value, update, isLoading, isFieldOverridden, resetField } = useAppSettingsKey('notifications');
  const { translate } = useSessionMessages();
  return <>
    <SettingsGroup>
      <SettingsRow title={translate('notifications.title')} description={translate('notifications.description')} control={<>
        <ResetToDefaultButton visible={isFieldOverridden('enabled')} defaultLabel={translate('reset.on')} onReset={() => resetField('enabled')} disabled={isLoading} />
        <Switch aria-label={translate('notifications.title')} checked={value?.enabled ?? true} disabled={isLoading} onCheckedChange={(enabled) => update({ enabled })} />
      </>} />
      <SettingsRow title={translate('notifications.sound')} control={<>
        <ResetToDefaultButton visible={isFieldOverridden('sound')} defaultLabel={translate('reset.on')} onReset={() => resetField('sound')} disabled={isLoading || value?.enabled === false} />
        <Switch aria-label={translate('notifications.sound')} checked={value?.sound ?? true} disabled={isLoading || value?.enabled === false} onCheckedChange={(sound) => update({ sound })} />
      </>} />
    </SettingsGroup>
    <AppNotificationPermissions />
  </>;
}
