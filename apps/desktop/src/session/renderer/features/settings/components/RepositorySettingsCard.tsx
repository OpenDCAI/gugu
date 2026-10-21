import React from 'react'
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key'
import { Input } from '@renderer/lib/ui/input'
import { Switch } from '@/components/ui/Switch'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { PRODUCT_NAME } from '@shared/app-identity'
import { DeviceSettingsNotice } from './DeviceSettingsScope'
import { ResetToDefaultButton } from './ResetToDefaultButton'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsPrimitives'

const RepositorySettingsCard: React.FC = () => {
  const {
    value: localProject,
    update: updateLocalProject,
    isLoading: localProjectLoading,
    isSaving: localProjectSaving,
    isFieldOverridden: isLocalProjectFieldOverridden,
    resetField: resetLocalProjectField,
    error: localProjectError
  } = useAppSettingsKey('localProject')
  const { translate } = useSessionMessages()

  const writeAgentConfigToGitIgnore = localProject?.writeAgentConfigToGitIgnore ?? true
  const defaultProjectsDirectory = localProject?.defaultProjectsDirectory ?? ''
  const localProjectBusy = localProjectLoading || localProjectSaving

  return (
    <SettingsGroup>
      {/* 看的是别的机器(#6264):离线 / 太旧时说一句,下面照旧画、一起灰。 */}
      <DeviceSettingsNotice error={localProjectError} hasData={localProject !== undefined} />
      <SettingsRow
        title={translate('repository.defaultProjectsDirectory')}
        description={translate('repository.defaultProjectsDirectoryDescription')}
        control={
          <Input
            key={defaultProjectsDirectory}
            defaultValue={defaultProjectsDirectory}
            onBlur={(event) => {
              const next = event.currentTarget.value.trim()
              if (next && next !== defaultProjectsDirectory)
                updateLocalProject({ defaultProjectsDirectory: next })
            }}
            aria-label={translate('repository.defaultProjectsDirectory')}
            disabled={localProjectBusy}
            className="w-72"
          />
        }
      />
      <SettingsRow
        title={translate('repository.autoGitignore')}
        description={translate('repository.autoGitignoreDescription', { appName: PRODUCT_NAME })}
        control={
          <>
            <ResetToDefaultButton
              visible={isLocalProjectFieldOverridden('writeAgentConfigToGitIgnore')}
              defaultLabel={translate('reset.on')}
              onReset={() => resetLocalProjectField('writeAgentConfigToGitIgnore')}
              disabled={localProjectBusy}
            />
            <Switch
              checked={writeAgentConfigToGitIgnore}
              onCheckedChange={(checked) =>
                updateLocalProject({ writeAgentConfigToGitIgnore: checked })
              }
              disabled={localProjectBusy}
              aria-label={translate('repository.autoGitignoreToggle')}
            />
          </>
        }
      />
    </SettingsGroup>
  )
}

export default RepositorySettingsCard
