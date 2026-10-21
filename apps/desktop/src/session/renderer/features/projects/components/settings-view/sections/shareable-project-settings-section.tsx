import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Field, FieldDescription, FieldTitle } from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { Switch } from '@renderer/lib/ui/switch';
import { Textarea } from '@renderer/lib/ui/textarea';
import type {
  ProjectConfigMigration,
  ProjectSettingsOverrideState,
  ShareableProjectSettingsWriteField,
} from '@shared/core/project-settings/project-settings';
import { ConfigMigrationNotice } from '../config-migration-notice';
import type { FormState, FormUpdate } from '../project-settings-form-model';
import {
  SHAREABLE_FIELD_DESCRIPTORS,
  type ShareableFieldDescriptor,
} from '../shareable-project-settings-fields';
import { ShareableSettingTitle } from '../shareable-setting-title';

type ShareableSettingsSectionProps = {
  form: FormState;
  update: FormUpdate;
  getOverrideSources: (
    field: ShareableProjectSettingsWriteField
  ) => ProjectSettingsOverrideState[ShareableProjectSettingsWriteField];
  configMigrations: ProjectConfigMigration[];
  importDisabled: boolean;
  openImportConfigModal: () => void;
};

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ShareableField({
  descriptor,
  form,
  update,
  getOverrideSources,
  beforeInput,
}: {
  descriptor: ShareableFieldDescriptor;
  form: FormState;
  update: FormUpdate;
  getOverrideSources: ShareableSettingsSectionProps['getOverrideSources'];
  beforeInput?: React.ReactNode;
}) {
  const { translate } = useSessionMessages();
  return (
    <Field>
      <ShareableSettingTitle
        leafLabel={translate(descriptor.leafLabelKey)}
        overrideSources={getOverrideSources(descriptor.id)}
        onRestore={() => update(descriptor.formKey, '')}
      >
        {descriptor.group
          ? titleCase(translate(descriptor.leafLabelKey))
          : translate(descriptor.modalLabelKey)}
      </ShareableSettingTitle>
      {descriptor.descriptionKey ? (
        <FieldDescription className="text-foreground-muted">
          {translate(descriptor.descriptionKey)}
        </FieldDescription>
      ) : null}
      {beforeInput}
      {descriptor.multiline ? (
        <Textarea
          rows={descriptor.id === 'preservePatterns' ? 5 : 3}
          placeholder={descriptor.placeholder}
          value={form[descriptor.formKey]}
          onChange={(e) => update(descriptor.formKey, e.target.value)}
        />
      ) : (
        <Input
          placeholder={descriptor.placeholder}
          value={form[descriptor.formKey]}
          onChange={(e) => update(descriptor.formKey, e.target.value)}
        />
      )}
    </Field>
  );
}

function AutoRunToggle({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-foreground-muted">{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

export function ShareableSettingsSection({
  form,
  update,
  getOverrideSources,
  configMigrations,
  importDisabled,
  openImportConfigModal,
}: ShareableSettingsSectionProps) {
  const { translate } = useSessionMessages();
  const topLevelFields = SHAREABLE_FIELD_DESCRIPTORS.filter((descriptor) => !descriptor.group);
  const lifecycleFields = SHAREABLE_FIELD_DESCRIPTORS.filter(
    (descriptor) => descriptor.group === 'lifecycle'
  );

  return (
    <>
      {topLevelFields.map((descriptor) => (
        <ShareableField
          key={descriptor.id}
          descriptor={descriptor}
          form={form}
          update={update}
          getOverrideSources={getOverrideSources}
        />
      ))}

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <FieldTitle>{translate('projects.settings.lifecycleScripts')}</FieldTitle>
          <FieldDescription className="text-foreground-muted">
            {translate('projects.settings.lifecycleScriptsDescription')}
          </FieldDescription>
        </div>

        {lifecycleFields.map((descriptor) => (
          <ShareableField
            key={descriptor.id}
            descriptor={descriptor}
            form={form}
            update={update}
            getOverrideSources={getOverrideSources}
            beforeInput={
              descriptor.id === 'scripts.setup' ? (
                <AutoRunToggle
                  label={translate('projects.settings.autoRunOnTaskCreation')}
                  checked={form.autoRunSetupScriptOnSessionCreation}
                  onCheckedChange={(checked) => update('autoRunSetupScriptOnSessionCreation', checked)}
                />
              ) : descriptor.id === 'scripts.run' ? (
                <AutoRunToggle
                  label={translate('projects.settings.autoRunOnTaskCreation')}
                  checked={form.autoRunRunScriptOnSessionCreation}
                  onCheckedChange={(checked) => update('autoRunRunScriptOnSessionCreation', checked)}
                />
              ) : undefined
            }
          />
        ))}

        <ConfigMigrationNotice
          migrations={configMigrations}
          disabled={importDisabled}
          onImport={openImportConfigModal}
        />
      </div>
    </>
  );
}
