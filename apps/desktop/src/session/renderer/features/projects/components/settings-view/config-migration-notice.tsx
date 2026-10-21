import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { PRODUCT_NAME } from '@shared/app-identity';
import type { ProjectConfigMigration } from '@shared/core/project-settings/project-settings';

export function ConfigMigrationNotice({
  migrations,
  disabled,
  onImport,
}: {
  migrations: ProjectConfigMigration[];
  disabled: boolean;
  onImport: () => void;
}) {
  const { translate } = useSessionMessages();
  if (migrations.length === 0) return null;

  return (
    <p className="text-xs text-foreground-muted">
      {translate('projects.settings.detectedExternalConfig')}{' '}
      <button
        type="button"
        onClick={onImport}
        disabled={disabled}
        className="text-foreground hover:underline"
      >
        {translate('projects.settings.importInto', { appName: PRODUCT_NAME })}
      </button>
    </p>
  );
}
