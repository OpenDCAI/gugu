/**
 * 手机端「看会话」这一半的本地库。
 *
 * owner 2026-09-09 拍板要：「手机端有些东西不需要每次都重新去请求，手机上应该有个数据库，
 * 把这些信息和消息存储起来」。在这之前这一半只有一份 `localStorage` 底稿 —— 5 条会话 ×
 * 每条 12 轮、512KB 封顶，于是往上一翻、切到第六条会话、回列表页，三种情况全都要重新回源，
 * 在他眼里那仍然是「每次都要请求」。
 *
 * 为什么是 IndexedDB 而不是 `localStorage`：后者只有 ~5MB，而且是**同步** API ——
 * 一条流式消息每秒推好几次，每次都整份序列化会直接卡住主线程，那正是这一批要消灭的那种卡。
 * 聊天那一半（`lib/localSyncDb.ts`）早就是这么做的，这里只是把同一条路补到看会话这一半。
 *
 * ⚠️ 这里存的**不是事实源**。它只负责让第一帧有东西，画出来之后立刻拿游标去对账；
 * 机器一旦说「世代变了」（记录被改写、整份重读），手里这份必须整份换掉。
 * 否则屏幕上会留下一份过期且永不更新的历史 —— 它不报错，和「读得慢」分辨不出来。
 */

// 名字是历史原因留下的(这个库先给手机「看会话」用,后来桌面的远程会话目录也存在这里):改名会让所有手机冷一次,
// 又没有实际收益,❌ 改。
const DB_NAME = 'gugu.agentWatch.v1'
const SCHEMA_VERSION = 1

export const AGENT_WATCH_STORES = ['timeline', 'sessions', 'meta'] as const
export type AgentWatchStoreName = (typeof AGENT_WATCH_STORES)[number]

export type LocalRow = { key: string; savedAt: number; [field: string]: unknown }

export interface AgentWatchLocalStore {
  readAll(store: AgentWatchStoreName): Promise<LocalRow[]>
  read(store: AgentWatchStoreName, key: string): Promise<LocalRow | null>
  put(store: AgentWatchStoreName, row: LocalRow): Promise<void>
  delete(store: AgentWatchStoreName, key: string): Promise<void>
  clear(): Promise<void>
}

/**
 * 拿不到 IndexedDB 时的退路（无痕模式、存储被禁、单测里的 jsdom）。
 *
 * 退成纯内存而不是抛错：**没有本地库只是回到「每次都请求」，不该让看会话这件事本身坏掉。**
 */
function createMemoryStore(): AgentWatchLocalStore {
  const tables = new Map<AgentWatchStoreName, Map<string, LocalRow>>(
    AGENT_WATCH_STORES.map((name) => [name, new Map<string, LocalRow>()])
  )
  return {
    async readAll(store) {
      return [...(tables.get(store)?.values() ?? [])]
    },
    async read(store, key) {
      return tables.get(store)?.get(key) ?? null
    },
    async put(store, row) {
      tables.get(store)?.set(row.key, row)
    },
    async delete(store, key) {
      tables.get(store)?.delete(key)
    },
    async clear() {
      for (const table of tables.values()) table.clear()
    }
  }
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, SCHEMA_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of AGENT_WATCH_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'))
    // 另一个标签页卡着旧版本时 upgrade 会一直挂着。挂着比报错更糟(页面永远在等)，
    // 所以给它一个了断，退回内存那条路。
    request.onblocked = () => reject(new Error('indexedDB upgrade blocked'))
  })
}

function run<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
  })
}

function createIndexedDbStore(db: IDBDatabase): AgentWatchLocalStore {
  const tx = (store: AgentWatchStoreName, mode: IDBTransactionMode): IDBObjectStore =>
    db.transaction(store, mode).objectStore(store)
  return {
    readAll: (store) => run(tx(store, 'readonly').getAll() as IDBRequest<LocalRow[]>),
    read: (store, key) =>
      run(tx(store, 'readonly').get(key) as IDBRequest<LocalRow | undefined>).then((row) => row ?? null),
    put: (store, row) => run(tx(store, 'readwrite').put(row)).then(() => undefined),
    delete: (store, key) => run(tx(store, 'readwrite').delete(key)).then(() => undefined),
    async clear() {
      for (const name of AGENT_WATCH_STORES) await run(tx(name, 'readwrite').clear())
    }
  }
}

let opening: Promise<AgentWatchLocalStore> | null = null

/**
 * 拿本地库。整个进程共用一份连接 —— 每次读写都开一次库，光开库就比省下来的那次请求还贵。
 *
 * 打不开一律退成内存库，且**只记一次**：这条路在无痕模式下每次读写都会走到，
 * 每次都打一行日志只会把控制台淹掉。
 */
export function getAgentWatchStore(factory?: IDBFactory): Promise<AgentWatchLocalStore> {
  if (opening) return opening
  const idb = factory ?? (typeof indexedDB === 'undefined' ? null : indexedDB)
  opening = idb
    ? openDatabase(idb)
        .then(createIndexedDbStore)
        .catch(() => createMemoryStore())
    : Promise.resolve(createMemoryStore())
  return opening
}

/** 测试与收尾用：丢掉当前连接，下次重新开。 */
export function resetAgentWatchStore(): void {
  opening = null
}
