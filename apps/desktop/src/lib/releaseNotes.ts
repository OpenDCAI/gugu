// @@@5813 更新说明 = **官网上的那一页**。这里只剩「该不该带他去、带他去哪一条」。
//
// 产品规则(product spec):更新说明是**装完新版、第一次打开**时给的,一个版本只给一次。
// ❌ 不在升级前给:那等于给「按一下就更新」那条路又加了一次点击。
//
// ❗ 应用里**没有**更新说明的内容,也没有画它的那套东西(owner 2026-09-18:「之前硬编码一拖还不改吗」)。
// 内容的家是官网仓的 content/release-notes/,渲染成
// gugu.nextmind.space/help/release-notes/<端>/ 那一页 —— 有配图、有目录、能搜能分享。
// 应用要做的只有一件事:把人带到那一页上他这一版的那一条。
//
// 这里还取一次那一页的 feed,但**不是为了拿内容**,是为了回答两个问题:
// 这一版有没有说明(没有就别带他去),以及它的锚点是哪个。
import { platform } from '../platform'

declare const __GUGU_CHANGELOG_URL__: string

export const RELEASE_NOTES_SEEN_KEY = 'gugu:releaseNotes:lastSeenVersion'

/**
 * feed 里的一条。应用只用得上 version(判这一版有没有说明)与 url(带他去哪儿)——
 * 标题、正文、配图都在网页上,❌ 不在这儿留一份副本。
 */
export interface ChangelogEntry {
  /** 这条说明描述的版本。 */
  version: string
  /** 这一条在网页上的地址(站点生成 feed 时逐条写进来)。 */
  url?: string
}

/**
 * 去哪一页。每条说明都带着自己的网址,去掉锚点就是这个端的发布说明页。
 * 一条都没有网址时返回 null —— ❌ 不在这儿拼一个地址:拼出来的那份要跟站点的目录结构同步,
 * 而渲染层根本看不见站点。
 */
export function releaseNotesPageUrl(entries: ChangelogEntry[]): string | null {
  for (const entry of entries) {
    if (typeof entry.url !== 'string' || entry.url.length === 0) continue
    try {
      const url = new URL(entry.url)
      url.hash = ''
      return url.toString()
    } catch {
      continue
    }
  }
  return null
}

/**
 * 去哪一条。有这一版的那一条就带他到那一条(带锚点),没有就带他到这一端的整页。
 * 两个都没有(一条都没取到)返回 null,调用方据此什么都不做。
 */
export function releaseNotesUrlFor(entries: ChangelogEntry[], version: string): string | null {
  const entry = findEntryForVersion(entries, version)
  if (entry && typeof entry.url === 'string' && entry.url.length > 0) return entry.url
  return releaseNotesPageUrl(entries)
}

/**
 * 去掉预发布后缀:beta 包的版本号形如 0.2.43-beta.641.1,它描述的仍是 0.2.43 这一版的内容。
 * 前导的 v 也一并去掉(feed 与 tag 两边写法不一致)。
 */
export function baseVersion(version: string): string {
  const withoutV = version.trim().replace(/^v/i, '')
  const cut = withoutV.search(/[-+]/)
  return cut === -1 ? withoutV : withoutV.slice(0, cut)
}

/**
 * 精确取这个版本的那一条(忽略预发布后缀)。取不到返回 null —— ❌ 不退回上一条:
 * 拿上一版的说明当这一版的介绍,比什么都不显示更糟。
 */
export function findEntryForVersion(
  entries: ChangelogEntry[],
  version: string,
): ChangelogEntry | null {
  const target = baseVersion(version)
  return entries.find((entry) => baseVersion(entry.version) === target) ?? null
}

export interface AutoOpenDecision {
  /** 这次启动要不要带他去看。 */
  open: boolean
  /**
   * 存回去的「看过的版本」;null = 这次**什么都别记**。
   * 手上一条说明都没有时必须是 null —— 内容是从网上取的,离线启动那一次如果先把当前版本记下来,
   * 等网络回来、说明取到了,就再也不会给了(这一版被当成"已经看过")。
   */
  remember: string | null
}

/**
 * 首次安装**不给**:新用户没有"上一版"可对照,给他一页「这一版改了什么」是答非所问。
 * 判据就是本机还没有存过任何版本号 —— 那一次只记住,不打开。
 */
export function decideAutoOpen(input: {
  lastSeenVersion: string | null
  currentVersion: string
  entries: ChangelogEntry[]
}): AutoOpenDecision {
  const current = baseVersion(input.currentVersion)
  if (!current) return { open: false, remember: null }
  if (input.entries.length === 0) return { open: false, remember: null }
  if (input.lastSeenVersion === null) return { open: false, remember: current }
  if (baseVersion(input.lastSeenVersion) === current) return { open: false, remember: current }
  // @@@5774 这一版还没有说明 —— **什么都别记**,与上面「一条都没取到」同一个理由:
  // 更新说明是独立发布的(不打进应用,改文案不用发版),所以「先发版、后补说明」是允许的顺序。
  // 记住版本号会让说明补上之后判据变成「已看过」,那批先打开的用户再也看不到。
  // 不记 = 下次启动重新判,说明到了就给;某版确实永远没说明也只是每次白判一次,无副作用。
  if (!findEntryForVersion(input.entries, current)) return { open: false, remember: null }
  return { open: true, remember: current }
}

/** localStorage 可能被禁用或抛异常;读不到一律当「从没存过」= 不打开。 */
export function readLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(RELEASE_NOTES_SEEN_KEY)
  } catch {
    return null
  }
}

export function writeLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(RELEASE_NOTES_SEEN_KEY, version)
  } catch {
    // 存不住就下次再判一次,不影响这次。
  }
}

/** 取回来的东西是别人写的文件,逐条验形状:缺 version 的条目直接丢掉,❌ 别让它把判断搅乱。 */
export function parseChangelog(raw: unknown): ChangelogEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is ChangelogEntry =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ChangelogEntry).version === 'string' &&
      (item as ChangelogEntry).version.length > 0,
    )
    .map((item) => ({
      version: item.version,
      ...(typeof item.url === 'string' && item.url.length > 0 ? { url: item.url } : {}),
    }))
}

/**
 * 去官网取一次那一页的 feed。取不到就返回 null —— 调用方据此这次什么都不做,
 * ❌ 不把「这次没取到」当成「没有更新说明」。
 */
export async function fetchChangelog(signal?: AbortSignal): Promise<ChangelogEntry[] | null> {
  // @@@5758 桌面端**必须由主进程去取**:渲染层的 origin 是 gugu-app://app,对站点是跨源。
  // (2026-09-18 在同一个 scheme 下起了一个最小 Electron 实测复现:渲染层失败,主进程 net.fetch 200;
  //  当时下载站一个 Access-Control-Allow-Origin 都不发,失败表现为 TypeError: Failed to fetch。)
  // @@@5813 搬到官网之后那个头有了(nginx 对那一支发 `*`),但这条路仍然只走主进程:
  // gugu-app:// 这种自定义 scheme 在跨源请求里本就是个不稳的前提,而主进程那条路不依赖任何前提。
  const viaHost = platform.fetchChangelog
  if (viaHost) {
    try {
      const raw = await viaHost()
      return raw === null || raw === undefined ? null : parseChangelog(raw)
    } catch {
      return null
    }
  }
  // 没有宿主桥 = web / 移动端,它们的 origin 是普通 https,照旧自己取(烘的是 android 那一份)。
  const url = typeof __GUGU_CHANGELOG_URL__ === 'string' ? __GUGU_CHANGELOG_URL__ : ''
  if (!url) return null
  try {
    const res = await fetch(url, { cache: 'no-cache', signal })
    if (!res.ok) return null
    return parseChangelog(await res.json())
  } catch {
    return null
  }
}

/**
 * 把人带到网页上去。Electron 里 window.open 被 main.ts 的 setWindowOpenHandler 接走
 * → shell.openExternal,所以桌面和 web 是同一句话。
 */
export function openReleaseNotesUrl(url: string): void {
  window.open(url, '_blank', 'noopener')
}
