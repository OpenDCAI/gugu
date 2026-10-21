import type { IFileSystem } from '@gugu/session-core/files';
import { log } from '@main/lib/logger';
import { remoteNameFromQualifiedRef } from '@shared/core/git/utils';
import {
  baseProjectSettingsSchema,
  legacyBaseProjectSettingsSchema,
  legacyProjectConfigSchema,
  shareableProjectSettingsSchema,
  type BaseProjectSettings,
  type ShareableProjectSettings,
} from '@shared/core/project-settings/project-settings';
import { mergeShareableProjectSettings } from '@shared/core/project-settings/project-settings-fields';
import {
  hasLegacyShareableConfigMigrated,
  markLegacyShareableConfigMigratedRaw,
  serializeShareableProjectSettings,
} from './legacy-shareable-migration-marker';
import { compactUndefined, parseJsonObject, readJson } from './project-settings-json';
import type { ProjectSettingsStorage, StoredProjectSettings } from './project-settings-storage';

export type LegacyProjectSettingsMigrationArgs = {
  projectId: string;
  row: StoredProjectSettings | undefined;
  configReader: Pick<IFileSystem, 'exists' | 'readText'> | undefined;
  configPath: string;
  defaultBranchFallback: string;
  storage: ProjectSettingsStorage;
  git?: ProjectSettingsGitInspector;
};

export type ProjectSettingsGitInspector = {
  isFileCleanlyTracked(filePath: string): Promise<boolean>;
};

function normalizeLegacyDefaultBranch(
  branch: BaseProjectSettings['defaultBranch'],
  remote: string | undefined,
  fallback: string
): BaseProjectSettings['defaultBranch'] {
  if (!branch) return undefined;
  const branchName = typeof branch === 'string' ? branch.trim() : branch.name.trim();
  if (!branchName) return undefined;
  if (branchName.includes('/')) return branchName;
  const remoteName = remote?.trim() || remoteNameFromQualifiedRef(fallback) || undefined;
  return remoteName ? `${remoteName}/${branchName}` : branchName;
}

async function readLegacyProjectConfig(
  configReader: Pick<IFileSystem, 'exists' | 'readText'> | undefined,
  configPath: string
): Promise<
  | (BaseProjectSettings & {
      remote?: string;
    })
  | undefined
> {
  if (!configReader) return undefined;
  try {
    const exists = await configReader.exists(configPath);
    if (!exists.success) {
      log.warn('Failed to check the legacy shared project config for migration', exists.error);
      return undefined;
    }
    if (!exists.data) return undefined;
    const content = await configReader.readText(configPath);
    if (!content.success) {
      log.warn('Failed to read the legacy shared project config for migration', content.error);
      return undefined;
    }
    if (content.data.truncated) {
      log.warn('The legacy shared project config was truncated during migration', {
        path: configPath,
        totalSize: content.data.totalSize,
      });
      return undefined;
    }
    const parsed = legacyProjectConfigSchema.safeParse(parseJsonObject(content.data.content));
    if (!parsed.success) {
      log.warn('Failed to parse the legacy shared project config for migration', parsed.error);
      return undefined;
    }
    return parsed.data;
  } catch (error) {
    log.warn('Failed to read the legacy shared project config for migration', error);
    return undefined;
  }
}

export async function migrateLegacyProjectSettingsIfNeeded({
  projectId,
  row,
  configReader,
  configPath,
  defaultBranchFallback,
  storage,
  git,
}: LegacyProjectSettingsMigrationArgs): Promise<void> {
  if (!row) return;

  const baseAlreadyMigrated = Boolean(row.legacyConfigMigratedAt);
  const shareableAlreadyMigrated = hasLegacyShareableConfigMigrated(
    row.shareableProjectSettingsJson
  );
  if (baseAlreadyMigrated && shareableAlreadyMigrated) return;

  const current = readJson(
    row.baseProjectSettingsJson,
    legacyBaseProjectSettingsSchema,
    'base project settings'
  );
  const currentShareable = readJson(
    row.shareableProjectSettingsJson,
    shareableProjectSettingsSchema,
    'shareable project settings'
  );
  const { remote, ...currentSettings } = current;
  const legacy = await readLegacyProjectConfig(configReader, configPath);
  const next: BaseProjectSettings = baseProjectSettingsSchema.parse({
    ...currentSettings,
    baseRemote: currentSettings.baseRemote ?? remote,
  });
  let nextShareable: ShareableProjectSettings | undefined;

  if (legacy && !baseAlreadyMigrated) {
    if (legacy.remote !== undefined) next.baseRemote = legacy.remote;
    if (legacy.baseRemote !== undefined) next.baseRemote = legacy.baseRemote;
    if (legacy.pushRemote !== undefined) next.pushRemote = legacy.pushRemote;
    if (legacy.defaultBranch !== undefined) {
      next.defaultBranch = normalizeLegacyDefaultBranch(
        legacy.defaultBranch,
        legacy.baseRemote ?? legacy.remote ?? next.baseRemote,
        defaultBranchFallback
      );
    }
    if (legacy.tmux !== undefined) next.tmux = legacy.tmux;
  }

  if (legacy && !shareableAlreadyMigrated) {
    if ((await git?.isFileCleanlyTracked(configPath)) === false) {
      const legacyShareable = shareableProjectSettingsSchema.parse(legacy);
      nextShareable = mergeShareableProjectSettings(currentShareable, legacyShareable);
    }
  }

  const update: Partial<StoredProjectSettings> = {
    ...(nextShareable
      ? {
          shareableProjectSettingsJson: serializeShareableProjectSettings(nextShareable, {
            previousRaw: row.shareableProjectSettingsJson,
            markLegacyShareableConfigMigrated: true,
          }),
        }
      : {}),
  };

  // gugu #2328: 无可迁移内容(无 legacy 配置 / 文件干净被跟踪)时也写收敛标记——否则该行永远
  // 停在「待迁移」,每次 mount 都为一个必然 no-op 重开远端 worktree lease + exists 探测。
  // base 侧本就无条件收敛(下方 legacyConfigMigratedAt),shareable 跟齐同一政策。
  if (!shareableAlreadyMigrated && !nextShareable) {
    update.shareableProjectSettingsJson = markLegacyShareableConfigMigratedRaw(
      row.shareableProjectSettingsJson
    );
  }

  if (!baseAlreadyMigrated) {
    update.baseProjectSettingsJson = JSON.stringify(compactUndefined(next));
    update.legacyConfigMigratedAt = new Date().toISOString();
  }

  if (Object.keys(update).length > 0) {
    await storage.update(projectId, update);
  }
}
