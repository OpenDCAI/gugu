import type { ParsedLogFile } from './token-log-file';
import { asRecord, type TokenEntry } from './token-readers/types';

type File = { path: string; parsed: ParsedLogFile };

function identity(file: File): { scope: string; parent?: string } | null {
  const state = asRecord(file.parsed.state);
  if (typeof state?.scope !== 'string') return null;
  return { scope: state.scope, parent: typeof state.forkedFrom === 'string' ? state.forkedFrom : undefined };
}

function sameRequest(a: TokenEntry, b: TokenEntry): boolean {
  return (a.legacyKey ?? a.key) === (b.legacyKey ?? b.key) && a.ts === b.ts && a.model === b.model
    && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/** No parent transcript, ambiguous lineage or diverged history means no inferred deduplication. */
export function canonicalizeCodexForks(files: readonly File[]): Map<string, readonly TokenEntry[]> {
  const byScope = new Map<string, File | null>();
  for (const file of files) {
    const id = identity(file);
    if (!id) continue;
    if (!byScope.has(id.scope)) {
      byScope.set(id.scope, file);
      continue;
    }
    const previous = byScope.get(id.scope);
    if (!previous) continue;
    const overlap = Math.min(previous.parsed.entries.length, file.parsed.entries.length);
    const compatible = identity(previous)?.parent === id.parent
      && previous.parsed.entries.slice(0, overlap).every((entry, i) => sameRequest(entry, file.parsed.entries[i]));
    if (!compatible) byScope.set(id.scope, null);
    else if (previous.parsed.entries.length < file.parsed.entries.length) byScope.set(id.scope, file);
  }
  const resolved = new Map<File, readonly TokenEntry[]>();
  const resolve = (file: File, ancestors: ReadonlySet<string>): readonly TokenEntry[] | null => {
    const id = identity(file);
    if (id && ancestors.has(id.scope)) return null;
    const cached = resolved.get(file);
    if (cached) return cached;
    const parent = id?.parent ? byScope.get(id.parent) : undefined;
    const next = new Set(ancestors);
    if (id) next.add(id.scope);
    const original = file.parsed.entries;
    const inherited = parent ? resolve(parent, next) : undefined;
    if (inherited === null) return null;
    let entries = original;
    if (inherited) {
      entries = [...original];
      for (let i = 0; i < entries.length && i < inherited.length; i += 1) {
        if (!sameRequest(entries[i], inherited[i])) break;
        entries[i] = { ...entries[i], key: inherited[i].key };
      }
    }
    resolved.set(file, entries);
    return entries;
  };
  return new Map(files.map((file) => [file.path, resolve(file, new Set()) ?? file.parsed.entries]));
}
