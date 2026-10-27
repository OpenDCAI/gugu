import { useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useOpenInApps } from '@renderer/lib/hooks/useOpenInApps';
import { Switch } from '@/components/ui/Switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { OPEN_IN_APPS, TERMINAL_OPEN_IN_APP_IDS, type OpenInAppId } from '@shared/openInApps';
import { useTerminalEnabled } from '../use-terminal-enabled';
import { SettingsRow } from '@/components/settings/SettingsPrimitives';

export default function HiddenToolsSettingsCard() {
  const { value: openIn, update, isLoading, isSaving } = useAppSettingsKey('openIn');
  const { icons, labels, availability } = useOpenInApps();
  const { translate } = useSessionMessages();

  const hiddenApps: OpenInAppId[] = openIn?.hidden ?? [];

  const toggle = (appId: OpenInAppId, visible: boolean) => {
    const next = visible ? hiddenApps.filter((id) => id !== appId) : [...hiddenApps, appId];
    update({ hidden: next });
  };

  const terminalEnabled = useTerminalEnabled();
  const sortedApps = useMemo(() => {
    // 「终端」开关关着:终端类 App 在这里也不列(与「在…中打开」同一条)。
    return Object.values(OPEN_IN_APPS).filter((app) => terminalEnabled || !TERMINAL_OPEN_IN_APP_IDS.has(app.id)).sort((a, b) => {
      const aDetected = availability[a.id] ?? a.alwaysAvailable ?? false;
      const bDetected = availability[b.id] ?? b.alwaysAvailable ?? false;
      if (aDetected && !bDetected) return -1;
      if (!aDetected && bDetected) return 1;
      return (labels[a.id] ?? a.label).localeCompare(labels[b.id] ?? b.label);
    });
  }, [availability, labels, terminalEnabled]);

  // 一个工具一行,用设置弹窗那一种行(product spec):图标、名称、检测状态、开关。外面的分组卡片由「界面」页给。
  return (
    <>
      {sortedApps.map((app) => {
        const isDetected = availability[app.id] ?? app.alwaysAvailable ?? false;
        const isVisible = isDetected && !hiddenApps.includes(app.id);
        const label = labels[app.id] ?? app.label;
        const icon = icons[app.id];
        const indicatorClass = isDetected ? 'bg-foreground-success' : 'bg-foreground-passive/50';
        return (
          <SettingsRow
            key={app.id}
            leading={icon ? <img src={icon} alt="" className="h-5 w-5 object-contain" /> : undefined}
            title={label}
            description={
              <span className="inline-flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${indicatorClass}`} />
                {isDetected ? translate('hiddenTools.detected') : translate('hiddenTools.notDetected')}
              </span>
            }
            control={
              <TooltipProvider delay={150}>
                <Tooltip>
                  <TooltipTrigger>
                    <span>
                      <Switch
                        checked={isVisible}
                        disabled={isLoading || isSaving || !isDetected}
                        onCheckedChange={(checked) => toggle(app.id, checked)}
                        aria-label={
                          isVisible
                            ? translate('hiddenTools.hideToggle', { tool: label })
                            : translate('hiddenTools.showToggle', { tool: label })
                        }
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {!isDetected
                      ? translate('hiddenTools.installToShow')
                      : isVisible
                        ? translate('hiddenTools.hideFromMenu')
                        : translate('hiddenTools.showInMenu')}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            }
          />
        );
      })}
    </>
  );
}
