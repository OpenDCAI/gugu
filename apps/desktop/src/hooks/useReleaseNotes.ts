// @@@5813 更新说明在**网页上**。这里只做两件事:装完新版第一次打开时把人带过去一次,
// 以及「设置 → 关于」那一行点了就带过去。
//
// 应用里没有更新说明的内容,也没有画它的那套东西 —— 内容的家是官网帮助中心。
// 这里仍取一次 feed,但**不是为了拿内容**:是为了回答「这一版有没有说明」「锚点是哪个」。
import { useEffect, useRef, useState } from 'react'
import {
  decideAutoOpen,
  fetchChangelog,
  openReleaseNotesUrl,
  readLastSeenVersion,
  releaseNotesUrlFor,
  writeLastSeenVersion,
  type ChangelogEntry,
} from '../lib/releaseNotes'
import { platform } from '../platform'

declare const __APP_VERSION__: string | undefined

// 打包时由 Vite 换成字面量。这是**唯一**在整棵 App 挂载期就会被读到的地方,所以不能裸读:
// 构建常量缺席的环境(单测直接渲染 App)裸读会 ReferenceError,把整棵树带崩。
// 读不到就先当空串 —— Electron 侧问到真值会盖上,而空串在 decideAutoOpen 那边等于
// 「这次什么都别做、什么都别记」,是安全的一侧。
// ⚠️ 必须在渲染时读,❌ 不能在模块顶层先算好:模块加载早于任何测试的 stub,提前算等于永远读不到。
function buildVersion(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

export interface ReleaseNotesOpener {
  /** 「设置 → 关于」那一行点了 —— 带他去网页上这一版的那一条。 */
  open: () => void
}

export function useReleaseNotes(): ReleaseNotesOpener {
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [version, setVersion] = useState(buildVersion)
  // 自动带过去这件事一次启动只许发生一次 —— 依赖变化重跑不该再开一个标签页。
  const openedOnce = useRef(false)

  useEffect(() => {
    const abort = new AbortController()
    void fetchChangelog(abort.signal).then((fresh) => {
      // null = 这次没取到(离线/站点挂了)。这次什么都不做,❌ 别当成「没有更新说明」。
      if (!fresh || abort.signal.aborted) return
      setEntries(fresh)
    })
    return () => abort.abort()
  }, [])

  useEffect(() => {
    if (!platform.capabilities.appVersion) return
    let alive = true
    platform.getAppVersion().then((live) => { if (alive) setVersion(live) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // 依赖 entries:离线启动那次手上是空的,decideAutoOpen 会要求「什么都别记」,
  // 等取回来内容再判一次 —— 否则这一版会被当成"已经看过"而永远不给。
  useEffect(() => {
    if (openedOnce.current) return
    const decision = decideAutoOpen({
      lastSeenVersion: readLastSeenVersion(),
      currentVersion: version,
      entries,
    })
    if (decision.remember !== null) writeLastSeenVersion(decision.remember)
    if (!decision.open) return
    const url = releaseNotesUrlFor(entries, version)
    if (url === null) return
    openedOnce.current = true
    openReleaseNotesUrl(url)
  }, [entries, version])

  return {
    open: () => {
      const url = releaseNotesUrlFor(entries, version)
      if (url !== null) openReleaseNotesUrl(url)
    },
  }
}
