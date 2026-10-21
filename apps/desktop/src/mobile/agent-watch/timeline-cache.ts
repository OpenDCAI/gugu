import type { ToolImage, ToolNode, TranscriptItem, TranscriptTurn } from '@gugu/session-core/acp/client'
import type { RecordCursor, Settlement } from '@gugu/session-core/session-record/contract'
import type { AgentWatchTimeline } from './agent-watch-store'
import { emptyAgentWatchTimeline } from './agent-watch-store'
import { getAgentWatchStore, type AgentWatchLocalStore, type LocalRow } from '@/session/shared/remote-sessions/local-store'

/**
 * 手机上「上次看到哪儿了」的本地留存。
 *
 * owner 2026-09-08 拍板要第一版（「赞同，并且支持信息存储可能更重要」）：进一条会话以前
 * **每次**都要等机器把整份快照送过来才有东西看，首屏永远是「正在读取时间线…」。
 * 2026-09-09 他指出第一版存得远远不够 ——「手机上应该有个数据库，把这些信息和消息存储起来，
 * 这样就不至于每次都要去请求了」。第一版是 5 条会话 × 每条 12 轮、512KB 封顶的
 * `localStorage` 底稿，于是往上一翻、切到第六条会话，照样回源。现在整份搬到 IndexedDB
 * （见 `local-store.ts`），存的是**手机见过的全部轮**，容量按字节算而不是按轮数掐。
 *
 * 两层，各管一件事：
 *   ① 内存 —— 同一次开着 App 的来回切页，同步命中，第一帧就有东西，连一次 await 都不等。
 *   ② IndexedDB —— **跨重启**。异步，所以进页时先用内存那份画，同时发起一次异步读补画。
 *
 * ⚠️ 留存**不是事实源**：画出来之后立刻拿游标去对账（订阅时带着它，机器发现世代不对会
 * 直接回一份新快照）。所以这里存的旧内容最多只在屏幕上停留到第一次对账，
 * ❌ 不存在「一直看着一份过期的时间线」那种状态。
 * ⚠️ 结算（审批/提问卡）**与游标一起存**：游标说的是「这一刻之前的我都有了」，对账只补游标之后
 *    变过的结算（timeline.ts `batchAfter`）。以前存游标不存结算，再进来时拿这个游标去对账，
 *    一条游标之前就在等人答的提问永远补不回来 —— 页头写着「在等你回答」，卡片却没了（2026-10-02 真机）。
 *    昨天那条待答若早已失效，失效那一步发生在游标之后，对账时照样补进来；对账前那一瞬点下去，
 *    宿主按 CAS 回 already_resolved 并带回真值（applyLocalSettlement）。
 */

/** 存几条会话。手机上真正会来回切的远不止 5 条，按字节封顶就够，条数只挡住无限增长。 */
const MAX_ENTRIES = 50
/**
 * 单条会话的字节上限。
 *
 * 按**字节**而不是按轮数：真实会话里一轮的大小能差几百倍（一句「好」vs 一次整文件输出），
 * 掐轮数会让「12 轮」在两种会话上分别意味着 3KB 和 3MB。
 * 手机拿到的轮本来就过了传输裁剪（工具输出截断、单包 128KB），所以 4MB 足够存下很长一段。
 */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
/** 全部会话合计上限：超了按最后保存时间从旧到新删。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

export type TimelineCacheKey = { deviceId: string; sessionId: string }

type CachedEntry = {
  key: string
  savedAt: number
  cursor: RecordCursor
  turns: TranscriptTurn[]
  /** 游标那一刻的全部结算。游标只能和它覆盖到的数据一起存(见文件头)。 */
  settlements: Record<string, Settlement>
  /** 游标那一刻的排队提示(同上:队列一变游标就前进)。 */
  queuedPrompts?: AgentWatchTimeline['queuedPrompts']
  hasOlder: boolean
  bytes: number
}

function keyOf(key: TimelineCacheKey): string {
  return `${key.deviceId}:${key.sessionId}`
}

const memory = new Map<string, CachedEntry>()

function toTimeline(entry: CachedEntry): AgentWatchTimeline {
  return {
    ...emptyAgentWatchTimeline(),
    cursor: entry.cursor,
    turns: entry.turns,
    hasOlder: entry.hasOlder,
    settlements: entry.settlements,
    queuedPrompts: entry.queuedPrompts ?? []
  }
}

/** 形状不对的行直接丢：留存是可再生的，❌ 不为它做迁移，也 ❌ 不让它把整份读崩。 */
function asEntry(row: LocalRow | null): CachedEntry | null {
  if (!row) return null
  const e = row as Partial<CachedEntry>
  // 没有结算的是旧版存的行:它的游标盖不住结算,拿它对账正是卡片丢失的那条路 ⇒ 当没有,整份拉。
  if (typeof e.key !== 'string' || !Array.isArray(e.turns) || !e.cursor || !e.settlements) return null
  if (e.turns.length === 0) return null
  return {
    key: e.key,
    savedAt: typeof e.savedAt === 'number' ? e.savedAt : 0,
    cursor: e.cursor,
    turns: e.turns,
    settlements: e.settlements,
    ...(Array.isArray(e.queuedPrompts) ? { queuedPrompts: e.queuedPrompts } : {}),
    hasOlder: e.hasOlder === true,
    bytes: typeof e.bytes === 'number' ? e.bytes : 0
  }
}

/**
 * 同步取：只看内存。
 *
 * 进页第一帧要的就是"立刻有东西"，为它 await 一次 IndexedDB 等于把第一帧推到下一个宏任务 ——
 * 跨重启那一份由 `hydrateCachedTimeline` 补。
 */
export function readCachedTimeline(key: TimelineCacheKey): AgentWatchTimeline | null {
  const entry = memory.get(keyOf(key))
  return entry ? toTimeline(entry) : null
}

/**
 * 异步取：App 冷启动后第一眼不该是空页，这一层负责那一眼。
 *
 * 读不出来一律当作没有 —— 本地库坏了只是回到「每次都请求」，❌ 不该让看会话这件事失败。
 */
export async function hydrateCachedTimeline(key: TimelineCacheKey): Promise<AgentWatchTimeline | null> {
  const id = keyOf(key)
  const cached = memory.get(id)
  if (cached) return toTimeline(cached)
  try {
    const store = await getAgentWatchStore()
    const entry = asEntry(await store.read('timeline', id))
    if (!entry) return null
    memory.set(id, entry)
    return toTimeline(entry)
  } catch {
    return null
  }
}

/**
 * 存。内存同步落，库异步落 —— 调用方在流式更新里按 1.5 秒防抖调它。
 *
 * 单条超上限时先从最旧的轮起**一张张**拿掉手机取回来的工具图(`images`;`imageRefs` 留着,翻到那儿再去机器上取),
 * 拿够就停 —— ❌ 一轮的图整轮拿:最新那一轮两次 4×512K 只要拿掉 2 张就装得下,整轮拿冷启动就要重取 8 张(复核 10-16)。
 * 还装不下再**从头砍**（丢最早的轮），并如实把 `hasOlder` 置真：
 * ❌ 不把裁剪说成「这就是全部」，那会让界面收起"加载更早"的入口，用户再也翻不上去。
 * 图先走:它能按张再取,一轮字丢了要整段重翻;不先拿图,几张图就能把几十轮字挤出去。
 * 各轮大小只量一次(拿掉图的那一轮重量它自己):每丢一轮就整份 `JSON.stringify` 一次,超限时一次写要 40 多 ms。
 */
export function writeCachedTimeline(key: TimelineCacheKey, timeline: AgentWatchTimeline): void {
  if (!timeline.cursor || timeline.turns.length === 0) return
  const id = keyOf(key)
  const turns = [...timeline.turns] as TranscriptTurn[]
  const sizes = turns.map(sizeOf)
  // 从第 start 轮起整份的 JSON 长度 = 两个括号 + 各轮 + 轮间逗号。
  const bytesFrom = (start: number) => sizes.slice(start).reduce((sum, size) => sum + size + 1, 1)
  for (let i = 0; i < turns.length && bytesFrom(0) > MAX_ENTRY_BYTES; i++) {
    const bare = withoutFetchedImages(turns[i], bytesFrom(0) - MAX_ENTRY_BYTES)
    if (bare === turns[i]) continue
    sizes[i] = sizeOf(bare)
    turns[i] = bare
  }
  let start = 0
  while (turns.length - start > 1 && bytesFrom(start) > MAX_ENTRY_BYTES) start++
  const bytes = bytesFrom(start)
  const trimmed = start > 0
  const entry: CachedEntry = {
    key: id,
    savedAt: Date.now(),
    cursor: timeline.cursor,
    turns: trimmed ? turns.slice(start) : turns,
    settlements: { ...timeline.settlements },
    queuedPrompts: [...timeline.queuedPrompts],
    hasOlder: timeline.hasOlder || trimmed,
    bytes
  }
  memory.set(id, entry)
  void persist(entry)
}

/**
 * 一轮里手机取回来写进条目的图,按条目、按张从前往后拿掉,拿够 `excess` 字就停(只拿有 `imageRefs` 的 —— 没有 refs
 * 的图拿掉就再也取不回来)。拿掉的那一格空着(存出去是 null),一条的图都拿光了就去掉 `images`。没拿就原样返回。
 */
function withoutFetchedImages(turn: TranscriptTurn, excess: number): TranscriptTurn {
  let freed = 0
  const strip = (item: TranscriptItem): TranscriptItem => {
    if (freed >= excess || item.kind === 'message' || item.kind === 'thinking') return item
    let out = item as ToolNode
    if (out.kind !== 'tool-group' && out.images && out.imageRefs) {
      const images: (ToolImage | undefined)[] = [...out.images]
      let taken = false
      for (let i = 0; i < images.length && freed < excess; i++) {
        const image = images[i]
        if (!image) continue
        // 这一格存出去成了 null:省下的就是它自己那一段。
        freed += JSON.stringify(image).length - 'null'.length
        images[i] = undefined
        taken = true
      }
      if (taken) {
        const { images: _images, ...rest } = out
        out = (images.some(Boolean) ? { ...rest, images } : rest) as ToolNode
      }
    }
    const children = out.children?.map((child) => strip(child) as ToolNode)
    return children && children.some((child, i) => child !== out.children?.[i]) ? ({ ...out, children } as ToolNode) : out
  }
  const items = turn.items.map(strip)
  return items.some((item, i) => item !== turn.items[i]) ? { ...turn, items } : turn
}

function sizeOf(value: TranscriptTurn): number {
  try {
    return JSON.stringify(value).length
  } catch {
    // 存不进就当它无限大：宁可不存，也 ❌ 不让一份存不下的东西把写入路径整条炸掉。
    return Number.POSITIVE_INFINITY
  }
}

async function persist(entry: CachedEntry): Promise<void> {
  try {
    const store = await getAgentWatchStore()
    await store.put('timeline', entry as unknown as LocalRow)
    await noteInIndex(store, entry)
    await pruneIfDue(store)
  } catch {
    /* 写不进去(配额满/被禁)不影响正在看的这一份。 */
  }
}

/**
 * 一份**只记大小**的目录。
 *
 * ❌ 不能在每次写入后都 `getAll('timeline')` 去算总量：那是把整份历史（最多 64MB）
 * 从库里读出来一遍，而写入是**跟着流式消息每 1.5 秒发生一次**的 ——
 * 那样清理本身就成了这一批要消灭的那种卡。目录只有 key/savedAt/bytes，几百字节。
 */
type IndexRow = { key: string; savedAt: number; bytes: number }

const INDEX_KEY = 'timeline-index'

async function readIndex(store: AgentWatchLocalStore): Promise<IndexRow[]> {
  const row = await store.read('meta', INDEX_KEY)
  const items = row?.items
  return Array.isArray(items) ? (items as IndexRow[]) : []
}

async function noteInIndex(store: AgentWatchLocalStore, entry: CachedEntry): Promise<void> {
  const rest = (await readIndex(store)).filter((one) => one.key !== entry.key)
  const next = [{ key: entry.key, savedAt: entry.savedAt, bytes: entry.bytes }, ...rest]
  await store.put('meta', { key: INDEX_KEY, savedAt: Date.now(), items: next })
}

/**
 * 清理有节流：条数与总量都是**慢变量**，没必要每写一次就算一次。
 *
 * 上限本身留了余量，所以晚几分钟才收拢没有代价；而每次都收拢是实打实的开销。
 */
const PRUNE_INTERVAL_MS = 5 * 60_000
let lastPruneAt = 0

async function pruneIfDue(store: AgentWatchLocalStore): Promise<void> {
  const now = Date.now()
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now
  const rows = (await readIndex(store)).sort((a, b) => b.savedAt - a.savedAt)
  const kept: IndexRow[] = []
  let total = 0
  for (const [index, row] of rows.entries()) {
    total += row.bytes
    if (index < MAX_ENTRIES && total <= MAX_TOTAL_BYTES) {
      kept.push(row)
      continue
    }
    memory.delete(row.key)
    await store.delete('timeline', row.key)
  }
  if (kept.length !== rows.length) {
    await store.put('meta', { key: INDEX_KEY, savedAt: now, items: kept })
  }
}

/** 测试与收尾用：内存与库一起清。 */
export async function clearTimelineCache(): Promise<void> {
  memory.clear()
  lastPruneAt = 0
  try {
    await (await getAgentWatchStore()).clear()
  } catch {
    /* 清不掉不是错误。 */
  }
}

/**
 * 只丢掉进程内那一层，库里那份留着 —— **冷启动就是这个形状**。
 *
 * 测试用：跨重启这条路只有把内存清掉才量得到，否则每次都命中内存层，
 * 库里存没存下来根本判不出来。
 */
export function forgetInMemoryTimelines(): void {
  memory.clear()
}
