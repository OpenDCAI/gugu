import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@/components/ui/Switch';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';
import { useSessionMessages } from '@renderer/localization/use-session-messages';


const InterfaceSettingsCard: React.FC = () => {
  const { translate } = useSessionMessages();
  const {
    value: interfaceSettings,
    update,
    isLoading: loading,
    isSaving: saving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');

  const hideContextBar = interfaceSettings?.hideContextBar ?? false;
  // 出厂 = 问。设置还没读回来时也按「问」显示,与 archive-task-flow 的兜底同一个方向:
  // ❌ 让一个读不到偏好的瞬间把开关画成「已关」。
  const confirmBeforeArchive = interfaceSettings?.confirmBeforeArchive ?? true;
  const confirmBeforeCancelAndSend = interfaceSettings?.confirmBeforeCancelAndSend ?? true;

  return (
    <SettingsGroup>
      <SettingsRow
        title={translate('settings.contextBar')}
        description={translate('settings.contextBarDescription')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('hideContextBar')}
              defaultLabel={translate('settings.contextBarShown')}
              onReset={() => resetField('hideContextBar')}
              disabled={loading || saving}
            />
            <Switch
              checked={hideContextBar}
              disabled={loading || saving}
              onCheckedChange={(checked) => update({ hideContextBar: checked })}
            />
          </>
        }
      />
      {/* owner 2026-09-05:归档谈不谈是一项设置。用户在确认框里勾了「不再询问」之后,
          没有别的地方能反悔 —— 这一行就是那条回头路。删除不在此列:不可撤销的动作,确认不是偏好。 */}
      <SettingsRow
        title={translate('settings.confirmBeforeArchive')}
        description={translate('settings.confirmBeforeArchiveDescription')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('confirmBeforeArchive')}
              defaultLabel={translate('settings.confirmBeforeArchiveAsk')}
              onReset={() => resetField('confirmBeforeArchive')}
              disabled={loading || saving}
            />
            <Switch
              checked={confirmBeforeArchive}
              disabled={loading || saving}
              onCheckedChange={(checked) => update({ confirmBeforeArchive: checked })}
            />
          </>
        }
      />
      {/* owner 2026-09-23:「取消回合并发送」的确认与归档同一个形状 —— 确认框里勾「不再询问」,这里反悔。 */}
      <SettingsRow
        title={translate('settings.confirmBeforeCancelAndSend')}
        description={translate('settings.confirmBeforeCancelAndSendDescription')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('confirmBeforeCancelAndSend')}
              defaultLabel={translate('settings.confirmBeforeArchiveAsk')}
              onReset={() => resetField('confirmBeforeCancelAndSend')}
              disabled={loading || saving}
            />
            <Switch
              checked={confirmBeforeCancelAndSend}
              disabled={loading || saving}
              onCheckedChange={(checked) => update({ confirmBeforeCancelAndSend: checked })}
            />
          </>
        }
      />
    </SettingsGroup>
  );
};

export default InterfaceSettingsCard;
