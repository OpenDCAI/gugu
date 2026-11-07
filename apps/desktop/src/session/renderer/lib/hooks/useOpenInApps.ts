import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useTerminalEnabled } from '@renderer/features/settings/use-terminal-enabled';
import { rpc } from '@renderer/lib/ipc';
import {
  getResolvedIconPath,
  getResolvedLabel,
  OPEN_IN_APPS,
  openInMenuApps,
  type OpenInAppConfig,
  type OpenInAppId,
  type PlatformKey,
} from '@shared/openInApps';

const iconModules = import.meta.glob('../../../assets/images/*', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function getIconUrl(iconPath: string): string | undefined {
  return iconModules[`../../../assets/images/${iconPath}`];
}

export interface UseOpenInAppsResult {
  icons: Partial<Record<OpenInAppId, string>>;
  labels: Partial<Record<OpenInAppId, string>>;
  availability: Record<string, boolean>;
  menuApps: OpenInAppConfig[];
  platform?: PlatformKey;
  loading: boolean;
}

export function useOpenInApps(): UseOpenInAppsResult {
  const { value: openIn, isLoading: settingsLoading } = useAppSettingsKey('openIn');
  const terminalEnabled = useTerminalEnabled();

  const { data: platform, isLoading: platformLoading } = useQuery({
    queryKey: ['app', 'platform'],
    queryFn: () => rpc.app.getPlatform() as Promise<PlatformKey>,
    staleTime: Infinity,
  });

  const { data: availability = {}, isLoading: availabilityLoading } = useQuery({
    queryKey: ['app', 'installedApps'],
    queryFn: async () => {
      const apps = await rpc.app.checkInstalledApps();
      return (apps ?? {}) as Record<string, boolean>;
    },
    staleTime: 5 * 60 * 1000,
  });

  const loading = settingsLoading || platformLoading || availabilityLoading;

  const labels = useMemo(() => {
    const result: Partial<Record<OpenInAppId, string>> = {};
    if (!platform) return result;
    for (const app of Object.values(OPEN_IN_APPS)) {
      result[app.id] = getResolvedLabel(app, platform);
    }
    return result;
  }, [platform]);

  const icons = useMemo(() => {
    const result: Partial<Record<OpenInAppId, string>> = {};
    if (!platform) return result;
    for (const app of Object.values(OPEN_IN_APPS)) {
      const iconPath = getResolvedIconPath(app, platform);
      const url = getIconUrl(iconPath);
      if (url) result[app.id] = url;
    }
    return result;
  }, [platform]);

  const menuApps = useMemo(
    () => (loading ? [] : openInMenuApps({ installed: availability, hidden: openIn?.hidden, terminalEnabled, defaultApp: openIn?.default })),
    [availability, loading, openIn?.default, openIn?.hidden, terminalEnabled]
  );

  return { icons, labels, availability, menuApps, platform, loading };
}
