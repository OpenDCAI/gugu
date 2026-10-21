import type { IFileSystem } from '@gugu/session-core/files';
import { err, ok, type Result } from '@gugu/session-shared';
import { log } from '@main/lib/logger';
import type {
  MigrateProjectConfigRequest,
  ProjectConfigMigration,
} from '@shared/core/project-settings/project-settings';
import type { UpdateProjectSettingsError } from '@shared/projects';
import type { ProjectProvider } from '../../project-provider';
import { codexConfigMigrator } from './codex-config-migration';
import { conductorConfigMigrator } from './conductor-config-migration';
import {
  errorMessage,
  openProjectFileSystem,
  projectPath,
  writeConfigFailed,
} from './config-migration-utils';
import { paseoConfigMigrator } from './paseo-config-migration';
import { supersetConfigMigrator } from './superset-config-migration';
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from './workspace-config-file';

export type ProjectConfigMigrator = {
  provider: ProjectConfigMigration['provider'];
  inspect: (
    project: ProjectProvider,
    fileSystem: IFileSystem
  ) => Promise<ProjectConfigMigration | null>;
  migrate: (
    project: ProjectProvider,
    request: MigrateProjectConfigRequest
  ) => Promise<Result<ProjectConfigMigration, UpdateProjectSettingsError>>;
};

const PROJECT_CONFIG_MIGRATORS = [
  conductorConfigMigrator,
  supersetConfigMigrator,
  paseoConfigMigrator,
  codexConfigMigrator,
] as const;

/**
 * 仓里已经有一份共享配置了吗 —— 改名前那份也算数,否则会当着一份现成配置的面
 * 从别家工具再导一份进来,把用户已有的设置盖掉。
 */
async function hasExistingProjectConfig(
  project: ProjectProvider,
  fileSystem: IFileSystem
): Promise<Result<boolean, { message: string }>> {
  for (const name of [CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    const found = await fileSystem.exists(projectPath(project, name));
    if (!found.success) return err(found.error);
    if (found.data) return ok(true);
  }
  return ok(false);
}

export async function inspectProjectConfigMigrations(
  project: ProjectProvider
): Promise<ProjectConfigMigration[]> {
  const fileSystem = openProjectFileSystem(project);
  if (!fileSystem.success) {
    log.warn('Failed to open project file system before config migration', fileSystem.error);
    return [];
  }

  const existingConfig = await hasExistingProjectConfig(project, fileSystem.data);
  if (!existingConfig.success) {
    log.warn(`Failed to inspect ${CONFIG_FILE} before config migration`, existingConfig.error);
    return [];
  }
  if (existingConfig.data) return [];

  const migrations = await Promise.all(
    PROJECT_CONFIG_MIGRATORS.map(async (migrator) => {
      try {
        return await migrator.inspect(project, fileSystem.data);
      } catch (error) {
        log.warn(`Failed to inspect ${migrator.provider} config for migration`, error);
        return null;
      }
    })
  );

  return migrations.filter((migration): migration is ProjectConfigMigration => migration !== null);
}

export async function migrateProjectConfigFromProvider(
  project: ProjectProvider,
  request: MigrateProjectConfigRequest
): Promise<Result<ProjectConfigMigration, UpdateProjectSettingsError>> {
  try {
    const fileSystem = openProjectFileSystem(project);
    if (!fileSystem.success) return fileSystem;

    const existingConfig = await hasExistingProjectConfig(project, fileSystem.data);
    if (!existingConfig.success) {
      return writeConfigFailed(
        `Could not check existing ${CONFIG_FILE}: ${existingConfig.error.message}`
      );
    }
    if (existingConfig.data) {
      return writeConfigFailed(`${CONFIG_FILE} already exists.`);
    }

    const migrator = PROJECT_CONFIG_MIGRATORS.find(
      (candidate) => candidate.provider === request.provider
    );
    if (!migrator) return writeConfigFailed('Unsupported config provider.');

    return await migrator.migrate(project, request);
  } catch (error) {
    log.warn(`Failed to migrate ${request.provider} config to project config`, error);
    return writeConfigFailed(errorMessage(error));
  }
}
