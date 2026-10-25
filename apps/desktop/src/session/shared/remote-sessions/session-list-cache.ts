import { getAgentWatchStore } from './local-store'

/**
 * 手机当设备(usePhoneAgentDirectory)那一格的本地底稿:打开就先铺上次那份,真数据到了再换。电脑那一格不存这一份,
 * 「上次的样子」是它随心跳上报的摘要(见 deviceSessionsOf)。
 *
 * 这一格原先**完全没存**：每次回列表页、每次冷启动，都要等机器把整份列表送过来才有东西看，
 * 而列表恰恰是进 App 第一眼看到的那一页。
 */
export type CachedSessionList<P, S> = { projects: readonly P[]; sessions: readonly S[] }

export async function readCachedSessionList<P, S>(
  deviceId: string
): Promise<CachedSessionList<P, S> | null> {
  try {
    const store = await getAgentWatchStore()
    const row = await store.read('sessions', deviceId)
    if (!row || !Array.isArray(row.projects) || !Array.isArray(row.sessions)) return null
    return { projects: row.projects as P[], sessions: row.sessions as S[] }
  } catch {
    return null
  }
}

export function writeCachedSessionList<P, S>(deviceId: string, list: CachedSessionList<P, S>): void {
  void (async () => {
    try {
      const store = await getAgentWatchStore()
      await store.put('sessions', {
        key: deviceId,
        savedAt: Date.now(),
        projects: [...list.projects],
        sessions: [...list.sessions]
      })
    } catch {
      /* 同上：存不下不影响这一次已经拿到的列表。 */
    }
  })()
}
