import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  packParsedLogFile,
  parseLogFile,
  unpackParsedLogFile,
  type ParsedLogFile,
} from './token-log-file';
import type { TokenEntry, TokenLogReader } from './token-readers/types';
import type { NativeHome } from '@gugu/session-core/agents/plugins';
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers';

export type CachedLogFileRow = { path: string; size: number; mtimeMs: number; data: string };

/** 一份要写回 `usage_token_file_cache` 的行(解析发生在 worker 里,落库由主进程做)。 */
export type CachedLogFileSave = CachedLogFileRow & { provider: string; providerSessionId: string };

export type ProviderTokenEntry = TokenEntry & { provider: string; providerSessionId: string };

export type TokenScanStats = {
  files: number;
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
 * 解析结果的内存层。库缓存(`usage_token_file_cache`,单机实测约 11 MB JSON)只在它的生命期里灌入一次
 * ({@link hydrateParsedFileMemory}),之后每次扫描只 stat 文件、命中就直接用已解析的条目。
 */
export type ParsedFileMemory = {
  files: Map<string, { size: number; mtimeMs: number; parsed: ParsedLogFile }>;
};

export function createParsedFileMemory(): ParsedFileMemory {
  return { files: new Map() };
}

/** 把库缓存的行灌进内存层;认不出的行(老版本 / 截断)跳过,对应文件下次整份重读。 */
export function hydrateParsedFileMemory(memory: ParsedFileMemory, rows: readonly CachedLogFileRow[]): void {
  for (const row of rows) {
    const parsed = unpackParsedLogFile(row.data);
    if (parsed) memory.files.set(row.path, { size: row.size, mtimeMs: row.mtimeMs, parsed });
  }
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
  onFileError?: (path: string, error: unknown) => void;
}): Promise<{ entries: ProviderTokenEntry[]; stats: TokenScanStats }> {
  const stats: TokenScanStats = { files: 0, cacheHits: 0, resumed: 0, fullParses: 0, bytesRead: 0 };
  const { memory } = options;
  const entries: ProviderTokenEntry[] = [];

  for (const reader of options.readers) {
    const providerSessionIds = new Set(
      options.providerSessions.filter((s) => s.provider === reader.provider).map((s) => s.providerSessionId)
    );
    if (providerSessionIds.size === 0) continue;
    const roots = options.rootsByProvider[reader.provider] ?? [];
    const located = await reader.locate(roots, providerSessionIds);
    const files: Array<{ path: string; providerSessionId: string }> = [];
    for (const [providerSessionId, paths] of located) {
      for (const path of paths) files.push({ path, providerSessionId });
    }
    stats.files += files.length;

    await mapWithConcurrency(files, 4, async ({ path, providerSessionId }) => {
      try {
        const info = await stat(path);
        const size = info.size;
        const mtimeMs = Math.floor(info.mtimeMs);
        const known = memory.files.get(path);

        let parsed: ParsedLogFile;
        if (known && known.size === size && known.mtimeMs === mtimeMs) {
          stats.cacheHits += 1;
          parsed = known.parsed;
        } else {
          const resume = known && known.parsed.offset <= size ? known.parsed : undefined;
          if (resume) stats.resumed += 1;
          else stats.fullParses += 1;
          stats.bytesRead += size - (resume?.offset ?? 0);
          parsed = await parseLogFile(path, reader, resume);
          memory.files.set(path, { size, mtimeMs, parsed });
          options.onSave({
            path,
            size,
            mtimeMs,
            provider: reader.provider,
            providerSessionId,
            data: packParsedLogFile(parsed),
          });
        }
        for (const entry of parsed.entries) entries.push({ ...entry, provider: reader.provider, providerSessionId });
      } catch (error) {
        // 一份文件读不了(刚被删 / 没权限)不该让整页用量打不开:这一份的 token 缺席,响亮记一笔。
        options.onFileError?.(path, error);
      }
    });
  }
  return { entries, stats };
}
