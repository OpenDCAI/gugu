import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

import * as schema from './schema';

// drizzle-kit 0.24's ESM API still contains CommonJS requires.
const { generateSQLiteDrizzleJson, generateSQLiteMigration } = createRequire(import.meta.url)(
  'drizzle-kit/api'
) as typeof import('drizzle-kit/api');

const metaDir = fileURLToPath(new URL('../../drizzle/meta/', import.meta.url));
const journal = JSON.parse(readFileSync(`${metaDir}_journal.json`, 'utf8')) as {
  entries: { idx: number; tag: string }[];
};
const snapshots = readdirSync(metaDir).filter(name => /^\d+_snapshot\.json$/.test(name)).sort();
const latestName = snapshots.at(-1)!;
const readSnapshot = (name: string) => JSON.parse(readFileSync(`${metaDir}${name}`, 'utf8')) as DrizzleSQLiteSnapshotJSON;
const latest = readSnapshot(latestName);

describe('session migration generation baseline', () => {
  it('has a snapshot for the latest journal entry, including hand-written migrations', () => {
    expect(latestName).toBe(`${String(journal.entries.at(-1)!.idx).padStart(4, '0')}_snapshot.json`);
  });

  it('keeps one generation history when independently authored migrations are combined', () => {
    for (let i = 1; i < snapshots.length; i++) {
      expect(readSnapshot(snapshots[i]).prevId).toBe(readSnapshot(snapshots[i - 1]).id);
    }
  });

  it('generates no migration when schema.ts has not changed', async () => {
    const current = await generateSQLiteDrizzleJson(schema, latest.id);
    // Check the shape before diffing: a stale snapshot can open an interactive rename prompt.
    expect(latest.tables).toEqual(current.tables);
    expect(await generateSQLiteMigration(latest, current)).toEqual([]);
  });
});
