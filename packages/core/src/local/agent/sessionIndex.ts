import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TranscriptScanOptions } from './transcriptSource'
import { describeTranscript, listLocalTranscriptFiles } from './transcriptInventory'
import { TRANSCRIPT_SOURCE_IDS } from '../../shared/types/transcripts'
import type { LocalTranscriptSession, TranscriptSource } from '../../shared/types/transcripts'

// 可增量、可缓存的本机会话索引。
//
// 会话页的导入面板要求「一打开就有东西看」，不能一次性读完每个文件的头部；
// 一台常用开发机上 14293 条会话全扫要 41.8 秒，会把面板钉死在加载态。
//
// 这里把工作切成两段：
//   ① 发现（readdir + 并发 stat）——只拿路径/时间/大小，实测同一台机 1.1 秒 15449 个文件；
//   ② 解析（读文件头部取标题/cwd/sessionId）——按最近更新优先、带时间预算分轮进行，
//      结果按 mtime+size 落盘缓存，下次开面板直接命中。
// 每轮返回 pending（还没解析的条数）交给调用方决定是否再来一轮，索引进度对用户可见，
// 不假装「就这么多」。
//
// ❌ 不做全文检索：搜索只匹配已解析出的标题与文件夹。要在 1.5 万个文件里搜正文是另一件事，
// 装成搜到了才是骗人。

/** 解析一个文件后缓存下来的东西；null = 解析过、但按清单口径不该出现（旁支/无对话）。 */
interface CachedDescription {
  providerSessionId: string
  title: string
  cwd: string | null
}

interface CacheEntry {
  /** 文件 mtime（epoch ms），与 size 一起当缓存有效性钥匙。 */
  mtimeMs: number
  sizeBytes: number
  source: TranscriptSource
  description: CachedDescription | null
}

interface CacheFile {
  version: 3
  entries: Record<string, CacheEntry>
}

const CACHE_VERSION = 3
const DEFAULT_HYDRATE_BUDGET_MS = 1200
const DEFAULT_CONCURRENCY = 64
const DEFAULT_RESCAN_INTERVAL_MS = 10_000
const STAT_CONCURRENCY = 128

export interface LocalSessionIndexOptions extends TranscriptScanOptions {
  /** 索引缓存落盘位置。不传 = 只在本进程内存里活着（单测/一次性调用）。 */
  cacheFilePath?: string
  /** 每轮用于解析新文件的时间预算（ms）。 */
  hydrateBudgetMs?: number
  /** 解析并发度。 */
  concurrency?: number
  /** 两次目录扫描之间的最小间隔（ms）；期间复用上一轮的发现结果。 */
  rescanIntervalMs?: number
  /** 便于测试注入的时钟。 */
  now?: () => number
  /** 宿主关闭索引源时停止调度新的目录与文件读取。 */
  signal?: AbortSignal
}

export interface LocalSessionQuery {
  /** Exact directory/path filters, shared by the import source and read-only App API. */
  cwd?: string
  filePath?: string
  offset?: number
  /** 只要某个引擎的会话；不传 = 全部。 */
  source?: TranscriptSource
  /** 关键词：对标题与所在文件夹做「空格分词、逐词都要命中」的大小写不敏感匹配。 */
  query?: string
  /** 返回条数上限。 */
  limit?: number
  /**
   * 本轮允许花在解析新文件上的时间（ms），覆盖索引默认值。
   * 首屏传小值（先出东西），之后几轮传大值（后台补齐）。
   */
  hydrateBudgetMs?: number
}

export interface LocalSessionPage {
  rows: LocalTranscriptSession[]
  /** 命中筛选条件的总条数（在已解析出的会话里）。 */
  matched: number
  /** 本机发现的会话文件总数（含当前筛选之外的）。 */
  discovered: number
  /** 已解析过的文件数——搜索只在这些里面进行。 */
  indexed: number
  /** 还没解析的文件数；>0 表示再调一轮会有更多结果。 */
  pending: number
  /**
   * true = 这一页直接来自上次的索引缓存，没有重新对过盘。
   * 用途只有一个：让面板瞬开先有东西看，随后那一次对账结果一到就替换掉。
   */
  stale: boolean
  /**
   * 每个引擎已经解析出多少条**可导入**的会话（不含旁支/无对话的文件）。
   * 索引没走完时它会一轮轮变大——这是真实进度，不是最终总数。
   */
  countsBySource: Record<TranscriptSource, number>
}

interface DiscoveredFile {
  source: TranscriptSource
  path: string
  mtimeMs: number
  sizeBytes: number
}

export interface LocalSessionIndex {
  /** 取一页；本轮顺带解析一批新文件（受时间预算约束）。会对账磁盘。 */
  readPage(query?: LocalSessionQuery): Promise<LocalSessionPage>
  /**
   * 只用上一轮落盘的索引出一页，**不扫盘**（毫秒级）。
   * 面板打开的第一帧用它，紧接着的 readPage 结果一到就覆盖。
   * 缓存为空时返回空页且 stale=false —— 那就是「还没索引过」，不是「没有会话」。
   */
  readCachedPage(query?: LocalSessionQuery): Promise<LocalSessionPage>
  /** 丢弃发现缓存，下一次 readPage 重新扫盘。 */
  invalidate(): void
  /**
   * 等后台落盘停下来。`readPage` **不等**落盘完成就返回（读不该被磁盘写阻塞），
   * 所以在删掉索引目录、或进程退出之前必须先 await 它——否则那次写会落在目录被删的
   * 过程中。实测：`await readPage()` 返回那一刻缓存文件尚未出现在磁盘上，约 200ms 后才落；
   * 在 mac1 CI 上表现为 `ENOTEMPTY … syscall: 'rm'`（dev@9ed8536c7 的 Unit tests 2/2）。
   * 保证的范围要说准：**在 flush 期间没有并发 readPage 的前提下**，resolve 后没有本索引
   * 发起的写在飞。若有并发 readPage 又把缓存写脏，它可能再排一次落盘——那种场景下调用方
   * 要自己先停掉读。落盘失败不抛错（只损失下次的加速）。
   */
  flush(): Promise<void>
}

/**
 * 每一家一个计数槽 —— 从 `TRANSCRIPT_SOURCE_IDS` 生成，不写字面量。
 * 从前这里是 `{ 'claude-code': 0, codex: 0 }`：接通第三家时它不会红，只会让那一家的计数
 * 从 `undefined` 开始，`undefined + 1` 得 NaN，面板上的引擎徽标显示为空白。
 */
function emptyCountsBySource(): Record<TranscriptSource, number> {
  return Object.fromEntries(TRANSCRIPT_SOURCE_IDS.map((id) => [id, 0])) as Record<
    TranscriptSource,
    number
  >
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      out[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return out
}

function matchesQuery(row: LocalTranscriptSession, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = `${row.title}\n${row.cwd ?? ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

function splitQuery(query: string | undefined): string[] {
  if (!query) return []
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

async function loadCache(
  cacheFilePath: string | undefined,
  signal?: AbortSignal
): Promise<Map<string, CacheEntry>> {
  if (!cacheFilePath) return new Map()
  try {
    signal?.throwIfAborted()
    const parsed = JSON.parse(await readFile(cacheFilePath, { encoding: 'utf8', signal })) as CacheFile
    signal?.throwIfAborted()
    if (parsed?.version !== CACHE_VERSION || typeof parsed.entries !== 'object') return new Map()
    return new Map(Object.entries(parsed.entries))
  } catch {
    signal?.throwIfAborted()
    // 缓存读不动（不存在/损坏/换了版本）→ 从零重建。缓存是加速器，不是真相来源。
    return new Map()
  }
}

async function saveCache(
  cacheFilePath: string | undefined,
  entries: Map<string, CacheEntry>
): Promise<void> {
  if (!cacheFilePath) return
  const payload: CacheFile = { version: CACHE_VERSION, entries: Object.fromEntries(entries) }
  const tmpPath = `${cacheFilePath}.tmp`
  await mkdir(dirname(cacheFilePath), { recursive: true })
  await writeFile(tmpPath, JSON.stringify(payload), 'utf8')
  await rename(tmpPath, cacheFilePath)
}

export function createLocalSessionIndex(options: LocalSessionIndexOptions): LocalSessionIndex {
  const now = options.now ?? (() => Date.now())
  const budgetMs = options.hydrateBudgetMs ?? DEFAULT_HYDRATE_BUDGET_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const rescanIntervalMs = options.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS

  let cache: Map<string, CacheEntry> | null = null
  let discovered: DiscoveredFile[] = []
  let discoveredAt = -Infinity
  let cacheDirty = false
  let persisting: Promise<void> | null = null

  async function ensureCache(): Promise<Map<string, CacheEntry>> {
    if (!cache) cache = await loadCache(options.cacheFilePath, options.signal)
    return cache
  }

  async function discover(): Promise<DiscoveredFile[]> {
    options.signal?.throwIfAborted()
    if (now() - discoveredAt < rescanIntervalMs) return discovered
    const jobs = await listLocalTranscriptFiles(options)
    const stated = await mapLimit(jobs, STAT_CONCURRENCY, async (job) => {
      options.signal?.throwIfAborted()
      try {
        const info = await stat(job.path)
        options.signal?.throwIfAborted()
        return {
          source: job.source,
          path: job.path,
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
        } satisfies DiscoveredFile
      } catch {
        options.signal?.throwIfAborted()
        // 扫描与读取之间文件被删/无权限 → 当它不存在，别让一个坏文件毁掉整份清单。
        return null
      }
    })
    discovered = stated.filter((file): file is DiscoveredFile => file !== null)
    discoveredAt = now()
    return discovered
  }

  function schedulePersist(): void {
    if (!cacheDirty || !options.cacheFilePath || persisting) return
    const snapshot = new Map(cache ?? [])
    cacheDirty = false
    persisting = saveCache(options.cacheFilePath, snapshot)
      .catch(() => {
        // 落盘失败只损失下次的加速，不影响本次结果。
        cacheDirty = true
      })
      .finally(() => {
        persisting = null
      })
  }

  async function flush(): Promise<void> {
    if (!options.cacheFilePath) return
    // 两轮封顶：第一轮等掉可能在飞的那次，第二轮把等待期间新脏的数据落一次。
    // ❌ 不写成 while：saveCache 失败会把 cacheDirty 置回 true，无界循环会在磁盘持续报错时空转。
    for (let round = 0; round < 2; round += 1) {
      schedulePersist()
      const inFlight = persisting
      if (!inFlight) return
      await inFlight
    }
  }

  function toRow(file: DiscoveredFile, description: CachedDescription): LocalTranscriptSession {
    return {
      source: file.source,
      providerSessionId: description.providerSessionId,
      title: description.title,
      cwd: description.cwd,
      filePath: file.path,
      updatedAt: file.mtimeMs,
      sizeBytes: file.sizeBytes,
    }
  }

  function selectPage(
    rows: LocalTranscriptSession[],
    query: LocalSessionQuery,
    terms: string[]
  ): { rows: LocalTranscriptSession[]; matched: number } {
    const matching = rows
      .filter((row) => (query.source ? row.source === query.source : true))
      .filter((row) => query.cwd === undefined || row.cwd === query.cwd)
      .filter((row) => query.filePath === undefined || row.filePath === query.filePath)
      .filter((row) => matchesQuery(row, terms))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const offset = query.offset ?? 0
    return { rows: matching.slice(offset, offset + (query.limit ?? 100)), matched: matching.length }
  }

  return {
    invalidate() {
      discoveredAt = -Infinity
    },

    flush,

    async readCachedPage(query: LocalSessionQuery = {}): Promise<LocalSessionPage> {
      options.signal?.throwIfAborted()
      const entries = await ensureCache()
      const countsBySource = emptyCountsBySource()
      const rows: LocalTranscriptSession[] = []
      for (const [path, entry] of entries) {
        if (!entry.description) continue
        rows.push(
          toRow(
            {
              source: entry.source,
              path,
              mtimeMs: entry.mtimeMs,
              sizeBytes: entry.sizeBytes,
            },
            entry.description
          )
        )
        countsBySource[entry.source] += 1
      }
      const selected = selectPage(rows, query, splitQuery(query.query))
      return {
        ...selected,
        discovered: entries.size,
        indexed: entries.size,
        pending: 0,
        countsBySource,
        stale: entries.size > 0,
      }
    },

    async readPage(query: LocalSessionQuery = {}): Promise<LocalSessionPage> {
      options.signal?.throwIfAborted()
      const entries = await ensureCache()
      const files = await discover()
      options.signal?.throwIfAborted()
      const terms = splitQuery(query.query)
      const limit = query.limit ?? 100

      const countsBySource = emptyCountsBySource()
      const rows: LocalTranscriptSession[] = []
      const stale: DiscoveredFile[] = []
      let indexed = 0
      for (const file of files) {
        const cached = entries.get(file.path)
        if (cached && cached.mtimeMs === file.mtimeMs && cached.sizeBytes === file.sizeBytes) {
          indexed += 1
          if (cached.description) {
            rows.push(toRow(file, cached.description))
            countsBySource[file.source] += 1
          }
          continue
        }
        stale.push(file)
      }

      // 最近更新的先解析：用户要找的几乎总在最近这一截，先让列表头部完整。
      // 同时把当前筛选的引擎排在前面，切到某个 agent 时先补它的。
      stale.sort((a, b) => {
        if (query.source) {
          const aWanted = a.source === query.source ? 0 : 1
          const bWanted = b.source === query.source ? 0 : 1
          if (aWanted !== bWanted) return aWanted - bWanted
        }
        return b.mtimeMs - a.mtimeMs
      })

      const deadline = now() + (query.hydrateBudgetMs ?? budgetMs)
      let hydratedCount = 0
      let cursor = 0
      const workers = Array.from({ length: Math.min(concurrency, stale.length) }, async () => {
        while (cursor < stale.length && now() < deadline) {
          options.signal?.throwIfAborted()
          const file = stale[cursor++]
          const described = await describeTranscript(file.source, file.path, options)
          options.signal?.throwIfAborted()
          const description: CachedDescription | null = described
            ? { providerSessionId: described.providerSessionId, title: described.title, cwd: described.cwd }
            : null
          entries.set(file.path, {
            mtimeMs: file.mtimeMs,
            sizeBytes: file.sizeBytes,
            source: file.source,
            description,
          })
          cacheDirty = true
          hydratedCount += 1
          if (description) {
            rows.push(toRow(file, description))
            countsBySource[file.source] += 1
          }
        }
      })
      await Promise.all(workers)
      options.signal?.throwIfAborted()
      indexed += hydratedCount
      schedulePersist()

      return {
        ...selectPage(rows, { ...query, limit }, terms),
        discovered: files.length,
        indexed,
        pending: files.length - indexed,
        countsBySource,
        stale: false,
      }
    },
  }
}
