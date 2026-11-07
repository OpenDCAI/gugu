import { localDayOf } from './local-day';
import { sourceAt, type SourceSpans } from './model-source';
import type { ParsedLogFile } from './token-log-file';
import type { TokenDayRow } from './token-fold';
import type { TokenEntry } from './token-readers/types';
import { preferSnapshot } from './token-snapshot';

export type TokenFileUpdate = {
  path: string; provider: string; providerSessionId: string;
  parsed: ParsedLogFile; added: readonly TokenEntry[]; reset: boolean;
};
type File = TokenFileUpdate & { rank: number; seen: boolean; sourceDirty: boolean; records: Map<string, Candidate> };
type Candidate = { file: File; first: TokenEntry; qualified?: TokenEntry; entry: TokenEntry; row: string | null };
type Candidates = Candidate | Candidate[];

/** Reversible contributions using exactly the full fold's whole-record selection policy. */
export function createIncrementalTokenFold() {
  const files = new Map<string, File>();
  const providers = new Map<string, Map<string, Candidates>>();
  const conflicts = new Set<Candidate[]>();
  const rows = new Map<string, { value: TokenDayRow; count: number }>();
  const days = new Map<number, string>();
  let sources: Readonly<Record<string, SourceSpans>> = {};
  let fingerprints = new Map<string, string>();
  let changedSources = new Set<string>();
  let orderChanged = false, rank = 0, processed = 0;
  let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function subtract(candidate: Candidate): void {
    if (candidate.row === null) return;
    const row = rows.get(candidate.row)!;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) row.value[field] -= candidate.entry[field];
    row.count -= 1;
    if (row.count === 0) rows.delete(candidate.row);
    candidate.row = null;
  }

  function contribute(candidate: Candidate): void {
    const { file, entry } = candidate;
    const bucket = Math.floor(entry.ts / (15 * 60_000));
    let day = days.get(bucket);
    if (day === undefined) { day = localDayOf(bucket * 15 * 60_000); days.set(bucket, day); }
    const source = sourceAt(sources[file.providerSessionId], entry.ts);
    const key = `${file.provider}\u0000${day}\u0000${entry.model}\u0000${source ?? ''}`;
    if (candidate.row === key) return;
    subtract(candidate);
    let row = rows.get(key);
    if (!row) {
      row = { count: 0, value: { provider: file.provider, day, model: entry.model, source, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      rows.set(key, row);
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) row.value[field] += entry[field];
    row.count += 1; candidate.row = key;
  }

  function choose(value: Candidates): void {
    const group = Array.isArray(value) ? value : [value];
    let selected = group[0];
    for (const candidate of group) if (candidate.file.rank < selected.file.rank) selected = candidate;
    let entry = selected.first;
    // A legacy first record locks selection. Otherwise later qualified records may win,
    // even in a file whose own first record was legacy. Keep both summaries per file/key.
    if (entry.quality && selected.file.provider === 'claude') {
      for (const candidate of group) {
        const best = candidate.qualified;
        if (best && (preferSnapshot('claude', best, entry)
          || (candidate.file.rank < selected.file.rank && !preferSnapshot('claude', entry, best)))) {
          selected = candidate; entry = best;
        }
      }
    }
    for (const candidate of group) if (candidate !== selected || candidate.entry !== entry) subtract(candidate);
    selected.entry = entry; contribute(selected);
  }

  function remove(file: File): void {
    const index = providers.get(file.provider)!;
    for (const [key, candidate] of file.records) {
      processed += 1; subtract(candidate);
      const value = index.get(key)!;
      if (!Array.isArray(value)) index.delete(key);
      else {
        value.splice(value.indexOf(candidate), 1);
        if (value.length === 1) { conflicts.delete(value); index.set(key, value[0]); choose(value[0]); }
        else choose(value);
      }
    }
    file.records.clear();
  }

  return {
    begin(nextSources: Readonly<Record<string, SourceSpans>>): void {
      sources = nextSources;
      const next = new Map(Object.entries(sources).map(([id, spans]) => [id, JSON.stringify(spans)]));
      changedSources = new Set([...fingerprints.keys(), ...next.keys()].filter((id) => fingerprints.get(id) !== next.get(id)));
      fingerprints = next; rank = 0; processed = 0; orderChanged = false;
      for (const file of files.values()) file.seen = false;
    },
    visit(update: TokenFileUpdate): void {
      const id = `${update.provider}\u0000${update.providerSessionId}\u0000${update.path}`;
      let file = files.get(id), entries = update.added;
      if (!file) {
        file = { ...update, rank, seen: true, sourceDirty: false, records: new Map() };
        files.set(id, file); entries = update.parsed.entries;
      } else {
        if (file.rank !== rank) orderChanged = true;
        if (update.reset) { remove(file); entries = update.parsed.entries; }
        Object.assign(file, update, { rank, seen: true, sourceDirty: changedSources.has(update.providerSessionId) });
      }
      rank += 1;
      let index = providers.get(file.provider);
      if (!index) providers.set(file.provider, index = new Map());
      for (const entry of entries) {
        processed += 1;
        let candidate = file.records.get(entry.key);
        if (candidate) {
          if (!entry.quality || (candidate.qualified && !preferSnapshot(file.provider, entry, candidate.qualified))) continue;
          candidate.qualified = entry; choose(index.get(entry.key)!);
        } else {
          candidate = { file, first: entry, qualified: entry.quality ? entry : undefined, entry, row: null };
          file.records.set(entry.key, candidate);
          const value = index.get(entry.key);
          if (!value) { index.set(entry.key, candidate); choose(candidate); }
          else if (Array.isArray(value)) { value.push(candidate); choose(value); }
          else { const group = [value, candidate]; index.set(entry.key, group); conflicts.add(group); choose(group); }
        }
      }
    },
    finish(): { rows: TokenDayRow[]; processed: number } {
      for (const [id, file] of files) if (!file.seen) { remove(file); files.delete(id); }
      if (orderChanged) for (const group of conflicts) choose(group);
      const currentZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (zone !== currentZone) {
        zone = currentZone; days.clear(); rows.clear();
        for (const file of files.values()) for (const candidate of file.records.values()) if (candidate.row !== null) {
          candidate.row = null; contribute(candidate); processed += 1;
        }
      } else if (changedSources.size) {
        for (const file of files.values()) if (file.sourceDirty) for (const candidate of file.records.values()) {
          if (candidate.row !== null) { contribute(candidate); processed += 1; }
        }
      }
      return { rows: [...rows.values()].map((row) => ({ ...row.value })), processed };
    },
  };
}
