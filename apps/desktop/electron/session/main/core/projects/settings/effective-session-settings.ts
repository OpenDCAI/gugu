import type { IFileSystem } from '@gugu/session-core/files';
import { log } from '@main/lib/logger';
import {
  defaultShareableProjectSettings,
  shareableProjectSettingsSchema,
  type ProjectSettings,
} from '@shared/core/project-settings/project-settings';
import { mergeShareableProjectSettings } from '@shared/core/project-settings/project-settings-fields';
import type { ProjectSettingsProvider } from './provider';

export async function getEffectiveSessionSettings(args: {
  projectSettings: ProjectSettingsProvider;
  sessionFs: Pick<IFileSystem, 'exists' | 'readText'>;
  sessionConfigPath: string;
}): Promise<ProjectSettings> {
  const { projectSettings, sessionFs, sessionConfigPath } = args;
  const parsedSettings = shareableProjectSettingsSchema.safeParse(await projectSettings.get());
  const localShareableSettings = parsedSettings.success ? parsedSettings.data : {};
  const defaults = defaultShareableProjectSettings();
  const exists = await sessionFs.exists(sessionConfigPath);
  if (!exists.success) {
    log.warn('Failed to check the session-level shared project config, falling back to project settings', exists.error);
    return mergeShareableProjectSettings(defaults, localShareableSettings);
  }
  if (!exists.data) {
    return mergeShareableProjectSettings(defaults, localShareableSettings);
  }

  try {
    const content = await sessionFs.readText(sessionConfigPath);
    if (!content.success) {
      log.warn('Failed to read the session-level shared project config, falling back to project settings', content.error);
      return mergeShareableProjectSettings(defaults, localShareableSettings);
    }
    if (content.data.truncated) {
      log.warn('The session-level shared project config was truncated, falling back to project settings', {
        path: sessionConfigPath,
        totalSize: content.data.totalSize,
      });
      return mergeShareableProjectSettings(defaults, localShareableSettings);
    }
    const projectFileSettings = shareableProjectSettingsSchema.parse(
      JSON.parse(content.data.content)
    );
    return mergeShareableProjectSettings(defaults, projectFileSettings, localShareableSettings);
  } catch (err) {
    log.warn('Failed to parse the session-level shared project config, falling back to project settings', err);
    return mergeShareableProjectSettings(defaults, localShareableSettings);
  }
}
