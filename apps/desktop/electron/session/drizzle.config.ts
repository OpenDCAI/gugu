import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { defaultDbFilePath, resolveDefaultUserDataPath } from './main/db/default-path';

function resolveDbUrl(): string {
  const explicit = process.env.GUGU_SESSION_DB_FILE?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  return defaultDbFilePath(resolveDefaultUserDataPath());
}

export default defineConfig({
  // Run drizzle-kit from this directory. Hand-written migrations must refresh
  // the latest generation baseline with `pnpm session:db:snapshot` at the repo root.
  schema: './main/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveDbUrl(),
  },
  strict: true,
  verbose: true,
});
