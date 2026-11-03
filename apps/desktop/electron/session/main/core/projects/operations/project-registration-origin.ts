import { eq } from 'drizzle-orm';
import { db, type AppDb, type DrizzleTx } from '@main/db/client';
import { kv } from '@main/db/schema';

const prefix = 'project-registration-origin:';
export type ProjectRegistrationOrigin = { version: 1; projectId: string; path: string; createdAt: string; source: 'automatic' | 'person' };

/** Written in the creation transaction; an automatic reuse must never stamp an older row. */
export function recordProjectRegistration(origin: Omit<ProjectRegistrationOrigin, 'version'>, runner: AppDb | DrizzleTx = db): void {
  const key = prefix + origin.projectId;
  const value = JSON.stringify({ version: 1, ...origin });
  runner.insert(kv).values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } }).run();
}

export function readProjectRegistration(projectId: string, runner: AppDb | DrizzleTx = db): ProjectRegistrationOrigin | null {
  const row = runner.select({ value: kv.value }).from(kv).where(eq(kv.key, prefix + projectId)).get();
  if (!row) return null;
  const value: unknown = JSON.parse(row.value);
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ProjectRegistrationOrigin>;
  return record.version === 1 && record.projectId === projectId && typeof record.path === 'string'
    && typeof record.createdAt === 'string' && (record.source === 'automatic' || record.source === 'person')
    ? record as ProjectRegistrationOrigin : null;
}
