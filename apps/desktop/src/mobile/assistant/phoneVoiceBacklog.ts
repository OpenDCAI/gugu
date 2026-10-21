// #7199 手机录的语音笔记在传到它家里之前先留在手机上(IndexedDB):它在休息 / 断网时不替人叫醒,录音也不能只活在内存里 ——
// 安卓随时可能把后台的咕咕杀掉。桌面没有这一层(桌面的录音只在内存里,关了 App 靠列表里点重试),手机的进程命短,多一道。
// 只存「还没传上去的段」与每条笔记的进度;传完的段当场删(手机的终点就是「传上去」)。读写都是尽力而为:存不下不能挡住录音与上传。

export type BacklogSegment = {
  /** 相对这条笔记的文件夹,如 `audio/000.wav`。 */
  file: string
  startMs: number
  durationMs: number
  voicedMs: number
  uploaded: boolean
}

export type BacklogJob = {
  id: string
  deviceId: string
  assistantId: string
  /** note.json 的整份(录的这一端维护)。 */
  meta: unknown
  segments: BacklogSegment[]
  recordingDone: boolean
  created: boolean
}

export interface VoiceBacklog {
  list(): Promise<BacklogJob[]>
  saveJob(job: BacklogJob): Promise<void>
  saveSegment(jobId: string, file: string, blob: Blob): Promise<void>
  readSegment(jobId: string, file: string): Promise<Blob | null>
  dropSegment(jobId: string, file: string): Promise<void>
  /** 这一条连同它的段一起删。 */
  dropJob(jobId: string): Promise<void>
}

const DB_NAME = 'gugu-phone-voice-notes'
const JOBS = 'jobs'
const SEGMENTS = 'segments'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'))
  })
}

/** 真的 IndexedDB(Android WebView 有)。库开不起来(隐私模式、被禁)= 每个调用抛,上层按「存不下」处理。 */
export function createIndexedDbBacklog(factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB): VoiceBacklog {
  let opened: Promise<IDBDatabase> | null = null
  const db = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('indexeddb unavailable'))
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, 1)
      open.onupgradeneeded = () => {
        open.result.createObjectStore(JOBS, { keyPath: 'id' })
        open.result.createObjectStore(SEGMENTS, { keyPath: 'key' })
      }
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error ?? new Error('indexeddb open failed'))
    })
    // 开失败了下次再试,❌ 把失败的那个 promise 留着。
    opened.catch(() => {
      opened = null
    })
    return opened
  }
  const key = (jobId: string, file: string) => `${jobId}/${file}`
  return {
    async list() {
      const store = (await db()).transaction(JOBS).objectStore(JOBS)
      return (await request(store.getAll())) as BacklogJob[]
    },
    async saveJob(job) {
      const tx = (await db()).transaction(JOBS, 'readwrite')
      tx.objectStore(JOBS).put(job)
      await done(tx)
    },
    async saveSegment(jobId, file, blob) {
      const tx = (await db()).transaction(SEGMENTS, 'readwrite')
      tx.objectStore(SEGMENTS).put({ key: key(jobId, file), jobId, file, blob })
      await done(tx)
    },
    async readSegment(jobId, file) {
      const row = (await request((await db()).transaction(SEGMENTS).objectStore(SEGMENTS).get(key(jobId, file)))) as { blob?: Blob } | undefined
      return row?.blob ?? null
    },
    async dropSegment(jobId, file) {
      const tx = (await db()).transaction(SEGMENTS, 'readwrite')
      tx.objectStore(SEGMENTS).delete(key(jobId, file))
      await done(tx)
    },
    async dropJob(jobId) {
      const handle = await db()
      const tx = handle.transaction([JOBS, SEGMENTS], 'readwrite')
      tx.objectStore(JOBS).delete(jobId)
      // 这条的段:key 以 `<id>/` 开头,左闭右开一个范围。
      tx.objectStore(SEGMENTS).delete(IDBKeyRange.bound(`${jobId}/`, `${jobId}/￿`))
      await done(tx)
    },
  }
}
