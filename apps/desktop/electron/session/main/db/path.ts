import { resolve } from 'node:path';
import { app } from 'electron';
import { resolveDefaultDatabasePath } from './database-file';

export interface ResolveDatabasePathOptions {
  userDataPath?: string;
}

export function resolveDatabasePath(options: ResolveDatabasePathOptions = {}): string {
  const explicitDbFile = process.env.GUGU_SESSION_DB_FILE?.trim();
  if (explicitDbFile) {
    return resolve(explicitDbFile);
  }

  return resolveDefaultDatabasePath(options.userDataPath ?? app.getPath('userData'));
}
