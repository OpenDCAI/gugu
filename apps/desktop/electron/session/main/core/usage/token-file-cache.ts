import { createCodexForkCache } from './token-fork-cache';
import { randomUUID } from 'node:crypto';
import { isParsedLogVersion, packParsedLogFile, unpackParsedLogFile, type ParsedLogFile } from './token-log-file';
import type { TokenEntry } from './token-readers/types';

export type CachedLogFileRow = { path: string; size: number; mtimeMs: number; data: string };
export type CachedLogFileSave = CachedLogFileRow & { provider: string; providerSessionId: string };
export const TOKEN_CACHE_PART_ENTRIES = 1024;
const PART_PREFIX = 'gugu-usage-chunk:';

type Storage = { generation: string; entryCount: number; fileId?: string };
export type CachedParsedFile = { size: number; mtimeMs: number; parsed: ParsedLogFile; latestTs?: number; sourceFileId?: string; storage?: Storage };
type Header = Storage & { kind: 'gugu-token-file-cache'; format: 1; parserVersion: ParsedLogFile['v']; parts: number; offset: number; state: ParsedLogFile['state'] };
export type ParsedFileMemory = {
  files: Map<string, CachedParsedFile>;
  heads: Map<string, { row: CachedLogFileRow; head: Header }>;
  parts: Map<string, Map<number, TokenEntry[]>>;
  storedParts: Set<string>;
  normalizeCodex: ReturnType<typeof createCodexForkCache>;
  normalized: Map<string, { entries: readonly TokenEntry[]; count: number }>;
};

export function createParsedFileMemory(): ParsedFileMemory {
  return { files: new Map(), heads: new Map(), parts: new Map(), storedParts: new Set(), normalizeCodex: createCodexForkCache(), normalized: new Map() };
}

/** Binary prefix ranges, also safe for paths containing SQL LIKE wildcards. */
export function tokenCachePartRange(path: string, generation?: string): { start: string; end: string } {
  const base = PART_PREFIX + Buffer.from(path).toString('base64url') + (generation ? ':' + generation : '');
  return { start: base + ':', end: base + ';' };
}

function partKey(path: string, generation: string, index: number): string {
  return tokenCachePartRange(path, generation).start + String(index).padStart(10, '0');
}

function decodePart(path: string): { file: string; generation: string; index: number } | null {
  const match = /^gugu-usage-chunk:([A-Za-z0-9_-]+):([a-f0-9-]{36}):(\d{10})$/.exec(path);
  if (!match) return null;
  const file = Buffer.from(match[1], 'base64url').toString();
  return Buffer.from(file).toString('base64url') === match[1]
    ? { file, generation: match[2], index: Number(match[3]) } : null;
}

/** Pages can arrive with heads before or after their parts. Finalize once before scanning. */
export function hydrateParsedFileMemory(memory: ParsedFileMemory, rows: readonly CachedLogFileRow[]): void {
  for (const row of rows) {
    try {
      const part = decodePart(row.path);
      if (part) {
        memory.storedParts.add(part.file);
        const parsed = unpackParsedLogFile(row.data);
        if (!parsed || parsed.entries.length > TOKEN_CACHE_PART_ENTRIES) continue;
        const key = part.file + '\u0000' + part.generation;
        let parts = memory.parts.get(key);
        if (!parts) memory.parts.set(key, parts = new Map());
        parts.set(part.index, parsed.entries);
        continue;
      }
      if (row.path.startsWith(PART_PREFIX)) continue;
      const value = JSON.parse(row.data) as Header;
      if (value?.kind === 'gugu-token-file-cache' && value.format === 1) {
        if (!isParsedLogVersion(value.parserVersion) || !Number.isSafeInteger(value.entryCount) || value.entryCount < 0 || value.entryCount > row.size
          || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > row.size
          || value.parts !== Math.ceil(value.entryCount / TOKEN_CACHE_PART_ENTRIES)
          || !/^[a-f0-9-]{36}$/.test(value.generation)
          || (value.state !== null && value.state !== undefined && (typeof value.state !== 'object' || Array.isArray(value.state)))) continue;
        memory.heads.set(row.path, { row, head: value });
      } else {
        const parsed = unpackParsedLogFile(row.data);
        if (parsed && parsed.offset <= row.size) memory.files.set(row.path, { size: row.size, mtimeMs: row.mtimeMs, parsed });
      }
    } catch {
      // Disposable cache: malformed rows must cause a reparse, not wrong totals.
    }
  }
}

export function finishParsedFileHydration(memory: ParsedFileMemory): void {
  for (const [path, { row, head }] of memory.heads) {
    const parts = memory.parts.get(path + '\u0000' + head.generation);
    const entries: TokenEntry[] = [];
    let complete = head.parts === 0 || (parts !== undefined && parts.size >= head.parts);
    if (complete) for (let index = 0; index < head.parts; index += 1) {
      const part = parts?.get(index);
      const count = Math.min(TOKEN_CACHE_PART_ENTRIES, head.entryCount - index * TOKEN_CACHE_PART_ENTRIES);
      if (!part || part.length !== count) { complete = false; break; }
      for (const entry of part) entries.push(entry);
    }
    if (complete) memory.files.set(path, {
      size: row.size, mtimeMs: row.mtimeMs,
      parsed: { v: head.parserVersion, offset: head.offset, state: head.state ?? null, entries },
      storage: { generation: head.generation, entryCount: head.entryCount, fileId: head.fileId },
    });
  }
  memory.heads.clear();
  memory.parts.clear();
}

/** Seal bounded parts first, then the checkpoint. A torn write is detected on hydration. */
export function saveParsedFileParts(options: {
  path: string; provider: string; providerSessionId: string; file: CachedParsedFile;
  previous?: Storage; fileId: string; onSave: (row: CachedLogFileSave) => void;
}): { generation: string; writtenEntries: number; reset: boolean } {
  const { path, provider, providerSessionId, file, previous, onSave } = options;
  const generation = previous?.generation ?? randomUUID();
  const count = file.parsed.entries.length;
  const start = previous?.entryCount === count ? Math.ceil(count / TOKEN_CACHE_PART_ENTRIES)
    : Math.floor((previous?.entryCount ?? 0) / TOKEN_CACHE_PART_ENTRIES);
  const parts = Math.ceil(count / TOKEN_CACHE_PART_ENTRIES);
  const base = { provider, providerSessionId, size: file.size, mtimeMs: file.mtimeMs };
  let writtenEntries = 0;
  // At most one previously committed tail part is rewritten, never a whole history.
  for (let index = start; index < parts; index += 1) {
    const entries = file.parsed.entries.slice(index * TOKEN_CACHE_PART_ENTRIES, (index + 1) * TOKEN_CACHE_PART_ENTRIES);
    writtenEntries += entries.length;
    onSave({ ...base, path: partKey(path, generation, index), data: packParsedLogFile({ v: file.parsed.v, offset: 0, state: null, entries }) });
  }
  const storage: Storage = { generation, entryCount: count, fileId: options.fileId };
  const head: Header = { kind: 'gugu-token-file-cache', format: 1, parserVersion: file.parsed.v, ...storage, parts, offset: file.parsed.offset, state: file.parsed.state };
  onSave({ ...base, path, data: JSON.stringify(head) });
  file.storage = storage;
  return { generation, writtenEntries, reset: !previous };
}
