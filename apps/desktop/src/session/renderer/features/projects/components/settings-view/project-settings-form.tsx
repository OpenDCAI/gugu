import type { GitRemote } from '@gugu/session-core/git';
import type { Result } from '@gugu/session-shared';
import { observer } from 'mobx-react-lite';
import { getGitRepositoryStore } from '@renderer/features/projects/stores/project-selectors';
import { FieldGroup } from '@renderer/lib/ui/field';
import type {
  MigrateProjectConfigRequest,
  MigrateProjectConfigResult,
  ProjectConfigMigration,
  ProjectSettings,
  ProjectSettingsOverrideState,
  ProjectSettingsPage,
  ProjectSettingsWriteTargetOption,
  WriteProjectConfigRequest,
} from '@shared/core/project-settings/project-settings';
import type { Project, UpdateProjectSettingsError } from '@shared/projects';
import { ProjectSettingsFooter } from './project-settings-footer';
import { BaseProjectSettingsSection } from './sections/base-project-settings-section';
import { ShareableSettingsSection } from './sections/shareable-project-settings-section';
import { useProjectSettingsForm } from './use-project-settings-form';

export interface ProjectSettingsFormProps {
  projectId: string;
  projectType: Project['type'];
  initial: ProjectSettings;
  writeTargets: ProjectSettingsWriteTargetOption[];
  overrideState: ProjectSettingsOverrideState;
  configMigrations: ProjectConfigMigration[];
  onSuccess: () => void;
  save: (settings: ProjectSettings) => Promise<Result<ProjectSettings, UpdateProjectSettingsError>>;
  writeConfigToRepo: (
    request: WriteProjectConfigRequest
  ) => Promise<Result<ProjectSettingsPage, UpdateProjectSettingsError>>;
  migrateProjectConfig: (
    request: MigrateProjectConfigRequest
  ) => Promise<Result<MigrateProjectConfigResult, UpdateProjectSettingsError>>;
}

const EMPTY_REMOTES: GitRemote[] = [];

export const ProjectSettingsForm = observer(function ProjectSettingsForm({
  projectId,
  projectType,
  initial,
  writeTargets,
  overrideState,
  configMigrations,
  onSuccess,
  save,
  writeConfigToRepo,
  migrateProjectConfig,
}: ProjectSettingsFormProps) {
  const repo = getGitRepositoryStore(projectId);
  const remotes = repo?.remotes ?? EMPTY_REMOTES;
  const baseRemote = repo?.baseRemote.name ?? 'origin';
  const formModel = useProjectSettingsForm({
    initial,
    baseRemote,
    remotes,
    writeTargets,
    overrideState,
    configMigrations,
    onSuccess,
    save,
    writeConfigToRepo,
    migrateProjectConfig,
  });

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div
        className="flex-1 overflow-x-hidden overflow-y-auto px-0.5 py-2"
        style={{ scrollbarWidth: 'none' }}
      >
        <FieldGroup>
          <BaseProjectSettingsSection
            projectId={projectId}
            form={formModel.form}
            projectType={projectType}
            remotes={remotes}
            update={formModel.update}
          />
          <ShareableSettingsSection
            form={formModel.form}
            update={formModel.update}
            getOverrideSources={formModel.getOverrideSources}
            configMigrations={formModel.configMigrations}
            importDisabled={formModel.importDisabled}
            openImportConfigModal={formModel.openImportConfigModal}
          />
        </FieldGroup>
      </div>
      <ProjectSettingsFooter
        dirty={formModel.dirty}
        saveStatus={formModel.saveStatus}
        canShareConfig={formModel.canShareConfig}
        shareDisabled={formModel.shareDisabled}
        onShare={formModel.openShareConfigModal}
        onUndo={formModel.handleUndo}
        onSave={() => void formModel.handleSave()}
      />
    </div>
  );
});
