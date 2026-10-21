import type { UserLibraryEntry, UserLibraryItem, UserLibraryVolume } from '@shared/user-library';

type RecordEntry = Omit<UserLibraryEntry, 'path' | 'index'>;
export function parseLibraryEntry(value: unknown, id: string): RecordEntry {
  if (!value || typeof value !== 'object') throw new Error('Invalid Gugu library entry');
  const row = value as Record<string, unknown>;
  if (row.id !== id || typeof row.name !== 'string' || !row.name.trim()
    || typeof row.description !== 'string' || typeof row.content !== 'string'
    || !(row.group === null || typeof row.group === 'string')
    || typeof row.modifiedAt !== 'string' || !Number.isFinite(Date.parse(row.modifiedAt))) throw new Error('Invalid Gugu library entry');
  return { id, name: row.name.trim(), description: row.description.trim(), group: row.group?.trim() || null,
    content: row.content, modifiedAt: row.modifiedAt };
}

/** The total index cannot drift from the independent records. */
export function aggregateLibraryIndex(volume: UserLibraryVolume, items: readonly UserLibraryItem[]): string {
  const lines = [`# ${volume.name}`];
  let group: string | null | undefined;
  for (const item of items) {
    if (item.group !== group) { group = item.group; if (group) lines.push(`\n## ${group}`); }
    const title = item.name.replace(/[[\]\n]/g, ' ');
    lines.push(`- [${title}](${item.id})${item.description ? ` — ${item.description.replace(/\n/g, ' ')}` : ''}`);
  }
  return lines.join('\n');
}
