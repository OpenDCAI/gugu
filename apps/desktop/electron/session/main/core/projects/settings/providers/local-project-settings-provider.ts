import path from 'node:path';
import type { IFileSystem } from '@gugu/session-core/files';
import {
  DbProjectSettingsProvider,
  type DbProjectSettingsProviderOptions,
} from './db-project-settings-provider';

export class LocalProjectSettingsProvider extends DbProjectSettingsProvider {
  constructor(
    projectId: string,
    projectPath: string,
    defaultBranchFallback: string = 'main',
    configReader: Pick<IFileSystem, 'exists' | 'readText'>,
    options: DbProjectSettingsProviderOptions = {}
  ) {
    super(projectId, projectPath, defaultBranchFallback, configReader, path.join, options);
  }
}
