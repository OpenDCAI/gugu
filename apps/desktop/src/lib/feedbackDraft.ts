// @@@2062 反馈草稿本地持久化。截图改「提交才上传」后,草稿期的图只以 dataURL 留在本地(绝不进
// 公有桶,隐私红线),关窗保留、重开续填。文字/模块小,图 dataURL 可达数 MB(4 张)→ 统一用
// IndexedDB(localStorage 会超配额);按 userId 分键,共享机上不串草稿。

export type FeedbackDraftImage = { id: string; dataUrl: string; name: string }
export type FeedbackDraft = { content: string; module: string; images: FeedbackDraftImage[] }

const DB_NAME = 'gugu-feedback-draft'
const STORE = 'draft'

function openDraftDb(indexedDb: IDBFactory = window.indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDb.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'userId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('open feedback-draft db failed'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('feedback-draft tx failed'))
  })
}

export async function loadFeedbackDraft(userId: string): Promise<FeedbackDraft | null> {
  const db = await openDraftDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(userId)
    const row = await new Promise<{ userId: string } & FeedbackDraft | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!row) return null
    return { content: row.content ?? '', module: row.module ?? 'chat', images: row.images ?? [] }
  } finally {
    db.close()
  }
}

export async function saveFeedbackDraft(userId: string, draft: FeedbackDraft): Promise<void> {
  const db = await openDraftDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ userId, ...draft })
    await txDone(tx)
  } finally {
    db.close()
  }
}

export async function clearFeedbackDraft(userId: string): Promise<void> {
  const db = await openDraftDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(userId)
    await txDone(tx)
  } finally {
    db.close()
  }
}

// 一张草稿图是否为空(全空白 = 无内容),用于「是否留草稿」判断。
export function isFeedbackDraftEmpty(draft: FeedbackDraft): boolean {
  return draft.content.trim() === '' && draft.images.length === 0
}

// File → dataURL(草稿内联预览 + 持久化)。
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('read file failed'))
    reader.readAsDataURL(file)
  })
}

// dataURL → File(提交时把草稿图还原成文件上传到桶)。
export function dataUrlToFile(dataUrl: string, name: string): File {
  const [head, b64] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}
