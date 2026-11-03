/** Refresh generation metadata after a hand-written migration; never writes SQL or the journal. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';
import * as schema from '../electron/session/main/db/schema';

// drizzle-kit 0.24's ESM API contains CommonJS requires; use its CommonJS entry.
const { generateSQLiteDrizzleJson } = createRequire(__filename)('drizzle-kit/api') as typeof import('drizzle-kit/api');

async function main() {
  const metaDir = resolve(__dirname, '../electron/session/drizzle/meta');
  const journal = JSON.parse(readFileSync(resolve(metaDir, '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const entry = journal.entries.at(-1);
  if (!entry) throw new Error('The session migration journal is empty');
  const name = `${String(entry.idx).padStart(4, '0')}_snapshot.json`;
  const names = readdirSync(metaDir).filter(file => /^\d+_snapshot\.json$/.test(file)).sort();
  if (names.some(file => file > name)) throw new Error('A snapshot is newer than the session migration journal');
  const read = (file: string) => JSON.parse(readFileSync(resolve(metaDir, file), 'utf8')) as DrizzleSQLiteSnapshotJSON;
  const previous = names.filter(file => file < name).at(-1);
  const current = names.includes(name) ? read(name) : undefined;
  const snapshot = await generateSQLiteDrizzleJson(schema, previous ? read(previous).id : undefined);
  // Preserve references from later snapshots when refreshing an existing baseline.
  if (current) snapshot.id = current.id;
  writeFileSync(resolve(metaDir, name), `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(`Updated session migration snapshot ${name} for ${entry.tag}\n`);
}

void main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
