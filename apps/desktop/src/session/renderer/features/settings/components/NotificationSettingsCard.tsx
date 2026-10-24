import { FolderOpen, Play } from '@/lib/icons'
import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/lib/ui/select';
import { Switch } from '@/components/ui/Switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { configureSoundPlayer, soundPlayer } from '@renderer/utils/soundPlayer';
import { PRODUCT_NAME } from '@shared/app-identity';
import type { NotificationSettings } from '@shared/core/app-settings';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';

const getFileName = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
};

function PreviewSoundButton({
  path,
  disabled,
}: {
  path: string;
  disabled?: boolean;
}): React.JSX.Element {
  const { translate } = useSessionMessages();
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-foreground-muted hover:text-foreground"
              disabled={disabled}
              onClick={() => soundPlayer.preview(path)}
              aria-label={translate('notifications.previewSound')}
            >
              <Play className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent side="top">{translate('notifications.preview')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const NotificationSettingsCard: React.FC = () => {
  const {
    value: notifications,
    update,
    isLoading: loading,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('notifications');
  const { translate } = useSessionMessages();

  const currentNotifications: NotificationSettings = notifications ?? {
    enabled: true,
    sound: true,
    customSoundPath: '',
    osNotifications: true,
    soundFocusMode: 'always',
  };
  const customSoundPath = currentNotifications.customSoundPath?.trim() ?? '';
  // 总开关关着时其余几行一起变淡、点不动(总开关那一行除外)。
  const dimmed = notifications?.enabled ? undefined : 'pointer-events-none opacity-33';

  const updateNotifications = (partial: Partial<NotificationSettings>) => {
    configureSoundPlayer({ ...currentNotifications, ...partial });
    update(partial);
  };

  const resetNotificationField = <K extends keyof NotificationSettings>(
    field: K,
    value: NotificationSettings[K]
  ) => {
    configureSoundPlayer({ ...currentNotifications, [field]: value });
    resetField(field);
  };

  const chooseCustomSound = async () => {
    const result = await rpc.app.openSelectAudioFileDialog({
      title: translate('notifications.chooseSoundDialogTitle'),
      message: translate('notifications.chooseSoundDialogMessage'),
    });
    if (result) updateNotifications({ customSoundPath: result });
  };

  return (
    <SettingsGroup>
      <SettingsRow
        title={translate('notifications.title')}
        description={translate('notifications.description')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('enabled')}
              defaultLabel={translate('reset.on')}
              onReset={() => resetField('enabled')}
              disabled={loading}
            />
            <Switch
              checked={notifications?.enabled ?? true}
              disabled={loading}
              onCheckedChange={(next) => updateNotifications({ enabled: next })}
            />
          </>
        }
      />
        <SettingsRow
          className={dimmed}
          title={translate('notifications.sound')}
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('sound')}
                defaultLabel={translate('reset.on')}
                onReset={() => resetNotificationField('sound', true)}
                disabled={loading}
              />
              {!customSoundPath && <PreviewSoundButton path="" disabled={loading} />}
              <Switch
                checked={notifications?.sound ?? true}
                disabled={loading}
                onCheckedChange={(next) => updateNotifications({ sound: next })}
              />
            </>
          }
        />

        <SettingsRow
          className={dimmed}
          title={translate('notifications.customSound')}
          description={translate('notifications.customSoundDescription')}
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('customSoundPath')}
                defaultLabel={translate('reset.builtIn')}
                onReset={() => resetNotificationField('customSoundPath', '')}
                disabled={loading}
              />
              {customSoundPath && <PreviewSoundButton path={customSoundPath} disabled={loading} />}
              <TooltipProvider delay={150}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="text-foreground-muted max-w-56 bg-transparent font-normal"
                        disabled={loading}
                        onClick={chooseCustomSound}
                        aria-label={
                          customSoundPath
                            ? translate('notifications.changeCustomSound')
                            : translate('notifications.chooseCustomSound')
                        }
                      >
                        <FolderOpen className="size-3.5 shrink-0" />
                        {/* @@@raw path — 已选文件名是用户数据,原样显示。 */}
                        <span className="truncate">
                          {customSoundPath
                            ? getFileName(customSoundPath)
                            : translate('notifications.chooseFile')}
                        </span>
                      </Button>
                    }
                  />
                  {customSoundPath && (
                    <TooltipContent side="top" className="break-all">
                      {customSoundPath}
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </>
          }
        />

        <SettingsRow
          className={dimmed}
          title={translate('notifications.soundTiming')}
          description={translate('notifications.soundTimingDescription')}
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('soundFocusMode')}
                defaultLabel={translate('reset.always')}
                onReset={() => resetNotificationField('soundFocusMode', 'always')}
                disabled={loading}
              />
              <Select
                value={notifications?.soundFocusMode ?? 'always'}
                onValueChange={(next) =>
                  updateNotifications({ soundFocusMode: next as 'always' | 'unfocused' })
                }
              >
                <SelectTrigger className="w-auto shrink-0 gap-2 [&>span]:line-clamp-none">
                  {/* Base UI 的 SelectValue 不给文案就画原值(always),这里画与选项同一句。 */}
                  <SelectValue>
                    {translate(
                      (notifications?.soundFocusMode ?? 'always') === 'unfocused'
                        ? 'notifications.soundUnfocused'
                        : 'notifications.soundAlways'
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="min-w-max">
                  <SelectItem value="always">{translate('notifications.soundAlways')}</SelectItem>
                  <SelectItem value="unfocused">
                    {translate('notifications.soundUnfocused')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </>
          }
        />

        <SettingsRow
          className={dimmed}
          title={translate('notifications.osNotifications')}
          description={translate('notifications.osNotificationsDescription', {
            appName: PRODUCT_NAME,
          })}
          control={
            <>
              <ResetToDefaultButton
                visible={isFieldOverridden('osNotifications')}
                defaultLabel={translate('reset.on')}
                onReset={() => resetNotificationField('osNotifications', true)}
                disabled={loading}
              />
              <Switch
                checked={notifications?.osNotifications ?? true}
                disabled={loading}
                onCheckedChange={(next) => updateNotifications({ osNotifications: next })}
              />
            </>
          }
        />
    </SettingsGroup>
  );
};

export default NotificationSettingsCard;
