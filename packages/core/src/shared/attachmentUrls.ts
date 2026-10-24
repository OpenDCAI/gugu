// 附件字节的链接只有这一个入口(附件进群文件夹 ③):
// 老消息直接用正文里的公开 URL;新消息指向群文件夹条目的某一版,链接由 Edge Function attachments/urls 现签
// (gugu-supabase supabase/functions/_shared/attachments-core.ts handleUrls)。渲染层和 Node(主进程、agent)共用,
// 各自只给「怎么调 /urls」。
//   · 同一轮里要的攒成一批(一次最多 200 个,同 /urls 的上限),气泡第一次画出来时一屏一次请求;
//   · 签好的链接按 expires_at 留着,过期前 REFRESH_MARGIN_MS 当作过期,重新签;
//   · 回答里没有的 = 看不见或条目已删 ⇒ gone(墓碑);
//   · 请求失败不缓存:每个调用方自己显示「暂时打不开 · 重试」,重试就是再要一次。
import type { AttachmentSource } from './ui/attachmentModels'

export const URLS_BATCH_MAX = 200
export const REFRESH_MARGIN_MS = 60_000

export interface AttachmentLink {
  status: 'ready'
  url: string
  /** 图片才有:CDN 现做的缩略图(同一个签名)。 */
  thumbUrl: string | null
  /** 内容的 sha256:新消息才有,本地缓存按它存。 */
  sha256: string | null
  width: number | null
  height: number | null
}
export type AttachmentResolution = AttachmentLink | { status: 'gone' } | { status: 'expired' }
export interface AttachmentMetadata { status: 'ready' | 'gone' | 'expired'; sha256: string | null }

/** /urls 回答里的一行(只读用到的):条目的回 item_id + version,悄悄话的回 message_id。 */
interface UrlRow {
  status?: 'ready' | 'expired'
  item_id?: string | null
  version?: number | null
  message_id?: string | null
  url?: string
  thumb_url: string | null
  sha256: string | null
  width: number | null
  height: number | null
  expires_at?: string
}

/** 一个要签的东西:群文件夹条目的某一版,或一条悄悄话附件消息。 */
export type AttachmentUrlRef = { item_id: string; version: number } | { message_id: string }
/** 调一次 attachments/urls:收 refs,回原样的 JSON(`{ urls: [...] }`)。失败就抛。 */
export type FetchAttachmentUrls = (refs: AttachmentUrlRef[]) => Promise<unknown>

const keyOfRef = (ref: AttachmentUrlRef) => ('message_id' in ref ? `msg:${ref.message_id}` : `${ref.item_id}@${ref.version}`)
const keyOfRow = (row: UrlRow) => (row.message_id ? `msg:${row.message_id}` : `${row.item_id}@${row.version}`)

function rowsOf(body: unknown): UrlRow[] {
  const urls = (body as { urls?: unknown } | null)?.urls
  if (!Array.isArray(urls)) throw new Error('attachments/urls answered without a urls list')
  return urls.filter((r): r is UrlRow => (typeof r?.message_id === 'string' || (typeof r?.item_id === 'string' && Number.isInteger(r?.version))) &&
    (r?.status === 'expired' || (typeof r?.url === 'string' && typeof r?.expires_at === 'string')))
}

export function createAttachmentResolver(fetchUrls: FetchAttachmentUrls, opts: { now?: () => number; schedule?: (flush: () => void) => void; fetchMetadata?: (ref: AttachmentUrlRef) => Promise<unknown> } = {}) {
  const now = opts.now ?? (() => Date.now())
  const schedule = opts.schedule ?? ((flush) => setTimeout(flush, 0))
  const signed = new Map<string, { link: AttachmentLink; freshUntil: number }>()
  const gone = new Set<string>()
  let queue = new Map<string, { ref: AttachmentUrlRef; waiters: { resolve: (r: AttachmentResolution) => void; reject: (e: unknown) => void }[] }>()
  let scheduled = false

  async function flush() {
    scheduled = false
    const batch = [...queue.values()]
    queue = new Map()
    for (let i = 0; i < batch.length; i += URLS_BATCH_MAX) {
      const chunk = batch.slice(i, i + URLS_BATCH_MAX)
      try {
        const rows = rowsOf(await fetchUrls(chunk.map((c) => c.ref)))
        const byKey = new Map(rows.map((r) => [keyOfRow(r), r]))
        for (const c of chunk) {
          const key = keyOfRef(c.ref)
          const row = byKey.get(key)
          let result: AttachmentResolution
          if (row?.status === 'expired') {
            // Re-upload can make the same reference readable again; expiry is never a permanent tombstone.
            result = { status: 'expired' }
          } else if (row?.url && row.expires_at) {
            const link: AttachmentLink = { status: 'ready', url: row.url, thumbUrl: row.thumb_url ?? null, sha256: row.sha256 ?? null, width: row.width ?? null, height: row.height ?? null }
            signed.set(key, { link, freshUntil: Date.parse(row.expires_at) - REFRESH_MARGIN_MS })
            result = link
          } else {
            gone.add(key)
            result = { status: 'gone' }
          }
          for (const w of c.waiters) w.resolve(result)
        }
      } catch (error) {
        for (const c of chunk) for (const w of c.waiters) w.reject(error)
      }
    }
  }

  function resolve(source: AttachmentSource): Promise<AttachmentResolution> {
    if (source.kind === 'url') return Promise.resolve({ status: 'ready', url: source.url, thumbUrl: null, sha256: null, width: null, height: null })
    if (source.kind === 'gone') return Promise.resolve({ status: 'gone' })
    const ref: AttachmentUrlRef = source.kind === 'message' ? { message_id: source.messageId } : { item_id: source.itemId, version: source.version }
    const key = keyOfRef(ref)
    if (gone.has(key)) return Promise.resolve({ status: 'gone' })
    const hit = signed.get(key)
    if (hit && hit.freshUntil > now()) return Promise.resolve(hit.link)
    return new Promise((res, rej) => {
      const entry = queue.get(key) ?? { ref, waiters: [] }
      entry.waiters.push({ resolve: res, reject: rej })
      queue.set(key, entry)
      if (!scheduled) {
        scheduled = true
        schedule(() => void flush())
      }
    })
  }

  /** 「重试」:丢掉这一项记着的链接(和 gone),下一次重新签。 */
  function forget(source: AttachmentSource) {
    if (source.kind !== 'item' && source.kind !== 'message') return
    const key = keyOfRef(source.kind === 'message' ? { message_id: source.messageId } : { item_id: source.itemId, version: source.version })
    signed.delete(key)
    gone.delete(key)
  }

  async function metadata(source: AttachmentSource): Promise<AttachmentMetadata> {
    if (source.kind === 'gone' || source.kind === 'url') return { status: source.kind === 'gone' ? 'gone' : 'ready', sha256: null }
    if (!opts.fetchMetadata) throw new Error('Attachment metadata is unavailable')
    const ref: AttachmentUrlRef = source.kind === 'message' ? { message_id: source.messageId } : { item_id: source.itemId, version: source.version }
    const row = await opts.fetchMetadata(ref) as Partial<AttachmentMetadata> | null
    if (!row || !['ready', 'expired', 'gone'].includes(row.status ?? '')) throw new Error('Invalid attachment metadata')
    return { status: row.status as AttachmentMetadata['status'], sha256: typeof row.sha256 === 'string' ? row.sha256 : null }
  }

  return { resolve, metadata, forget }
}
export type AttachmentResolver = ReturnType<typeof createAttachmentResolver>
