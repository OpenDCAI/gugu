import React from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Switch } from '@/components/ui/Switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives';

const SidebarMetadataSettingsCard: React.FC = () => {
  const {
    value: interfaceSettings,
    update,
    isLoading,
    isSaving,
    isFieldOverridden,
    resetField,
  } = useAppSettingsKey('interface');
  const { translate } = useSessionMessages();

  const busy = isLoading || isSaving;
  const showStateGroups = interfaceSettings?.showLeftSidebarStateGroups ?? false;
  const showAgentNameOnHover = interfaceSettings?.showLeftSidebarAgentNameOnHover ?? true;

  return (
    <SettingsGroup>
      <SettingsRow
        title={translate('sidebarMeta.stateGroups')}
        description={translate('sidebarMeta.stateGroupsDescription')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('showLeftSidebarStateGroups')}
              defaultLabel={translate('reset.on')}
              onReset={() => resetField('showLeftSidebarStateGroups')}
              disabled={busy}
            />
            <Switch
              checked={showStateGroups}
              onCheckedChange={(checked) => update({ showLeftSidebarStateGroups: checked })}
              disabled={busy}
              aria-label={translate('sidebarMeta.stateGroupsToggle')}
            />
          </>
        }
      />
      {/* #5818 指针压到会话行上,这一行就地变成它的 agent 名字。给开关是因为它换掉的是用户正在读的
          那一行的**内容**,不是多画一个角标 —— 有人要的就是「我扫的是标题,别在我眼皮底下变」
          (owner 2026-09-18)。默认开。 */}
      <SettingsRow
        title={translate('sidebarMeta.agentNameOnHover')}
        description={translate('sidebarMeta.agentNameOnHoverDescription')}
        control={
          <>
            <ResetToDefaultButton
              visible={isFieldOverridden('showLeftSidebarAgentNameOnHover')}
              defaultLabel={translate('reset.on')}
              onReset={() => resetField('showLeftSidebarAgentNameOnHover')}
              disabled={busy}
            />
            <Switch
              checked={showAgentNameOnHover}
              onCheckedChange={(checked) => update({ showLeftSidebarAgentNameOnHover: checked })}
              disabled={busy}
              aria-label={translate('sidebarMeta.agentNameOnHoverToggle')}
            />
          </>
        }
      />
    </SettingsGroup>
  );
};

export default SidebarMetadataSettingsCard;
