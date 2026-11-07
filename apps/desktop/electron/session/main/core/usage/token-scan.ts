import { recentTokenRefreshFrom, TOKEN_CACHE_VERSION } from './token-cache-version';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readLogFileDelta, type ParsedLogFile } from './token-log-file';
import { finishParsedFileHydration, saveParsedFileParts, type ParsedFileMemory, type CachedLogFileSave } from './token-file-cache';
import type { TokenFileUpdate } from './incremental-token-fold';
export { createParsedFileMemory, hydrateParsedFileMemory } from './token-file-cache';
export type { CachedLogFileRow, CachedLogFileSave, ParsedFileMemory } from './token-file-cache';
import type { TokenEntry, TokenLogReader } from './token-readers/types';
import type { NativeHome } from '@gugu/session-core/agents/plugins';
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers';

export type ProviderTokenEntry = TokenEntry & { provider: string; providerSessionId: string };

export type TokenScanStats = {
  files: number;
  /** Entries visited by the incremental fold, zero for an unchanged hot scan. */
  foldedEntries?: number;
  /** Bounded cache parts serialized this round, including at most one old tail per file. */
  cacheWriteEntries?: number;
  /** size 与 mtime 都没变,直接用缓存。 */
  cacheHits: number;
  /** 文件变长了,从上次的偏移接着读。 */
  resumed: number;
  /** 整份读(第一次见到 / 文件变短 / 缓存认不出)。 */
  fullParses: number;
  bytesRead: number;
};

/**
 * 这一家的配置根有哪几处:咕咕给它的影子 home 注入的覆盖,再接上插件 `nativeHome` 的候选
 * (用户自己环境里的覆盖、home 下的默认目录)。**全都扫** —— 改过配置目录的机器上默认目录里往往还留着旧会话。
 */
export function configRootsFor(
  nativeHome: NativeHome,
  agentHome: { root: string; env: Record<string, string> },
  processEnv: NodeJS.ProcessEnv = process.env
): string[] {
  const roots = [
    agentHome.env[nativeHome.envVar],
    ...nativeHomeRoots(nativeHome, processEnv, agentHome.root || homedir()),
  ].filter((root): root is string => typeof root === 'string' && root.trim().length > 0);
  return [...new Set(roots)];
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await run(item);
    }
  });
  await Promise.all(workers);
}

/**
 * 找出这些会话的日志文件,读出全部用量条目。没变的文件用内存层,变长的接着读,
 * 新解析的经 `onSave` 交出去落库。返回的条目**未去重**(去重是全局的,见 token-fold.ts)。
 */
export async function collectTokenEntries(options: {
  providerSessions: ReadonlyArray<{ provider: string; providerSessionId: string }>;
  readers: readonly TokenLogReader[];
  rootsByProvider: Readonly<Record<string, readonly string[]>>;
  memory: ParsedFileMemory;
  onSave: (row: CachedLogFileSave) => void;
  cacheCheckpoint?: (persist: () => void) => boolean;
  onPrune?: (path: string, generation: string) => void;
  onFile?: (file: TokenFileUpdate) => void;
  onFileError?: (path: string, error: unknown) => void;
  refreshSinceMs?: number;
}): Promise<{ entries: ProviderTokenEntry[]; stats: TokenScanStats }> {
  const stats: TokenScanStats = { files: 0, cacheHits: 0, resumed: 0, fullParses: 0, bytesRead: 0 };
  const { memory } = options;
  finishParsedFileHydration(memory);
  const visited = new Set<string>();
  const entries: ProviderTokenEntry[] = [];
  const refreshSinceMs = options.refreshSinceMs ?? recentTokenRefreshFrom();

  for (const reader of options.readers) {
    const providerSessionIds = new Set(
      options.providerSessions.filter((s) => s.provider === reader.provider).map((s) => s.providerSessionId)
    );
    if (providerSessionIds.size === 0) {
      if (reader.provider === 'codex') memory.normalizeCodex([]);
      continue;
    }
    const roots = options.rootsByProvider[reader.provider] ?? [];
    const located = await reader.locate(roots, providerSessionIds);
    const byPath = new Map<string, { path: string; sessionIds: string[] }>();
    for (const [providerSessionId, paths] of located) {
      for (const path of paths) {
        let file = byPath.get(path);
        if (!file) byPath.set(path, file = { path, sessionIds: [] });
        if (!file.sessionIds.includes(providerSessionId)) file.sessionIds.push(providerSessionId);
      }
    }
    const files = [...byPath.values()];
    stats.files += files.length;

    const updates = new Map<string, TokenFileUpdate>();
    await mapWithConcurrency(files, 4, async ({ path, sessionIds }) => {
      const providerSessionId = sessionIds[0];
      try {
        const info = await stat(path);
        const size = info.size;
        const mtimeMs = Math.floor(info.mtimeMs);
        const known = memory.files.get(path);

        const fileId = `${info.dev}:${info.ino}`;
        const knownFileId = known?.sourceFileId ?? known?.storage?.fileId;
        const sameFile = !knownFileId || knownFileId === fileId;
        const changed = !known || !sameFile || known.size !== size || known.mtimeMs !== mtimeMs;
        const upgrade = !!known && known.parsed.v !== TOKEN_CACHE_VERSION
          && (changed || (known.latestTs ??= known.parsed.entries.reduce((max, entry) => Math.max(max, entry.ts), -Infinity)) >= refreshSinceMs);
        let file = known;
        let added: TokenEntry[] = [];
        let reset = false;
        if (known && !changed && !upgrade) {
          stats.cacheHits += 1;
        } else {
          const resume = !upgrade && known && sameFile && size > known.size && known.parsed.offset <= size ? known.parsed : undefined;
          if (resume) stats.resumed += 1;
          else stats.fullParses += 1;
          stats.bytesRead += size - (resume?.offset ?? 0);
          const delta = await readLogFileDelta(path, reader, resume, { providerSessionId, refreshSinceMs });
          if (upgrade) delta.entries = [
            ...known.parsed.entries.filter((entry) => entry.ts < refreshSinceMs),
            ...delta.entries.filter((entry) => entry.ts >= refreshSinceMs),
          ];
          added = delta.entries;
          reset = !resume;
          const previous = resume ? known?.storage : undefined;
          if (resume) {
            // Reuse cached entry objects; never clone the whole history on append.
            for (const entry of added) resume.entries.push(entry);
          }
          file = { size, mtimeMs, sourceFileId: fileId, parsed: resume ? { ...delta, entries: resume.entries } : delta };
          memory.files.set(path, file);
          const hadStoredParts = memory.storedParts.has(path);
          const cachedFile = file;
          const persist = () => {
            const saved = saveParsedFileParts({ path, provider: reader.provider, providerSessionId,
              file: cachedFile, previous, fileId, onSave: options.onSave });
            stats.cacheWriteEntries = (stats.cacheWriteEntries ?? 0) + saved.writtenEntries;
            if (saved.reset && hadStoredParts) options.onPrune?.(path, saved.generation);
          };
          const saved = options.cacheCheckpoint ? options.cacheCheckpoint(persist) : (persist(), true);
          if (!saved) {
            if (previous) cachedFile.storage = previous;
            else delete cachedFile.storage;
          } else if (cachedFile.parsed.entries.length) memory.storedParts.add(path);
        }
        if (!file) throw new Error('Parsed token file unavailable');
        visited.add(path);
        updates.set(path, { path, provider: reader.provider, providerSessionId, parsed: file.parsed, added, reset });
      } catch (error) {
        // 一份文件读不了(刚被删 / 没权限)不该让整页用量打不开:这一份的 token 缺席,响亮记一笔。
        options.onFileError?.(path, error);
      }
    });
    const normalized = reader.provider === 'codex'
      ? memory.normalizeCodex(files.flatMap(({ path }) => {
        const update = updates.get(path);
        return update ? [{ path, parsed: update.parsed }] : [];
      })) : undefined;
    // 1914 precedence is locate order, never asynchronous read completion order.
    for (const { path, sessionIds } of files) {
      const update = updates.get(path);
      if (!update) continue;
      let value = update;
      if (normalized) {
        const current = normalized.get(path)!;
        const old = memory.normalized.get(path);
        const append = old && !update.reset && (current === old.entries
          || (current.length >= old.count && old.entries.slice(0, old.count).every((entry, i) =>
            entry.key === current[i].key && entry.ts === current[i].ts && entry.model === current[i].model
            && entry.input === current[i].input && entry.output === current[i].output
            && entry.cacheRead === current[i].cacheRead && entry.cacheWrite === current[i].cacheWrite)));
        value = { ...update, parsed: { ...update.parsed, entries: current as ParsedLogFile['entries'] },
          added: append ? current.slice(old.count) : current, reset: !append };
        memory.normalized.set(path, { entries: current, count: current.length });
      }
      for (const providerSessionId of sessionIds) {
        if (options.onFile) options.onFile({ ...value, providerSessionId });
        else for (const entry of value.parsed.entries) entries.push({ ...entry, provider: reader.provider, providerSessionId });
      }
    }
  }
  for (const path of memory.normalized.keys()) if (!visited.has(path)) memory.normalized.delete(path);
  for (const path of memory.files.keys()) if (!visited.has(path)) memory.files.delete(path);
  return { entries, stats };
}
