import feeds from './updateFeeds.json'
import type { UpdateChannel } from '../shared/update-policy'

// @@@5737 更新通道:**每个 tier 只跟自己那条**。正式版追正式版,Beta 追 Beta,验收包谁也不追。
//
// 原来(@@@2177)是所有 tier 运行期一律覆盖成查正式 feed,意图是「装 Beta 的人也被提示升到新正式版」。
// #5576 给正式 feed 加了 zip 之后这条变成了故障:有 zip 就走原生 Squirrel 原地换包,而原地换要求新包
// 满足**正在跑的那个包**的 designated requirement —— 它钉着 bundle id。Beta 与正式版(Mac 上
// nextmind.gugu.beta / nextmind.gugu,@@@7394 之前是 com.gugu.app.beta / com.gugu.app)是两个应用,
// 校验必不过(实测 `code failed to satisfy specified code requirement(s)`)。跨应用升级这件事本来就
// 不成立,所以按通道分开,从根上没有这个洞。
//
// 打包期与运行期读同一个 updateFeeds.json(electron-builder.cjs @@@tier-feed),改域名不会漂。

/**
 * tier → 它自己的通道。判据是**能不能原地换**:同一条通道上的包 bundle id 相同,才换得动。
 * acceptance-<tag> 每个 tag 一个独立 appId、没有任何人给它发包,所以它没有通道。
 */
export function resolveUpdateChannel(tier: string): UpdateChannel {
  if (tier === 'production') return 'stable'
  if (tier === 'beta') return 'beta'
  return 'none'
}

/** 通道的 feed 地址。none 没有地址 —— 调用方必须先关掉更新器,不是拿个空串去查。 */
export function updateFeedUrl(channel: UpdateChannel): string | null {
  if (channel === 'stable') return feeds.stable
  if (channel === 'beta') return feeds.beta
  return null
}

/**
 * 通道对应的 electron-updater channel 名,也就是它读的清单文件名(generic provider 按平台加后缀:
 * latest → latest.yml / latest-linux.yml)。与 electron-builder.cjs 的 tier.channel 同名。
 *
 * @@@7394 Mac 例外:Mac 换了应用标识(nextmind.gugu),新标识的包读自己那份 nextmind-mac.yml /
 * nextmind-beta-mac.yml(与 electron-builder.cjs 的 tier.macChannel 同名)。原来的 latest-mac.yml /
 * beta-mac.yml 只列 dmg,留给换标识前的老包走 dmg 换装 —— 新包要是还读它,就再也收不到原地静默更新。
 * 平台由调用方显式给:❌ 默认取 process.platform,同一条测试在 mac 与 linux 上会得出两个答案。
 */
export function updateChannelName(channel: UpdateChannel, platform: NodeJS.Platform): string | null {
  const mac = platform === 'darwin'
  if (channel === 'stable') return mac ? 'nextmind' : 'latest'
  if (channel === 'beta') return mac ? 'nextmind-beta' : 'beta'
  return null
}

/**
 * 交给 `autoUpdater.setFeedURL` 的 provider 配置。这是运行期**唯一**的 provider 来源:setFeedURL 直接用它建
 * provider(electron-updater AppUpdater.setFeedURL);只有从没 setFeedURL 时才拿打包进 app-update.yml 的那份
 * 建 provider,而通道启用时我们总会 setFeedURL —— 所以 electron-builder.cjs 的 publish 段 ❌ 再写一份。
 * (app-update.yml 运行期仍会被读别的字段:updaterCacheDirName、Windows 的 publisherName。)
 *
 * `useMultipleRangeRequest: false`:差分下载**一段一个请求**。下载站是阿里云 OSS + CDN(Tengine、x-oss-*),
 * 多段 Range 只回第一段(`206` + 单段 `Content-Range` + 原文件的 Content-Type);electron-updater 默认对
 * 非 s3.amazonaws.com 的地址发多段请求、要 multipart/byteranges,拿到别的就抛错退回整包。owner 10-09 Chole
 * 64.1→65.1:块表比对已经算出只要下 7%(14,803 KB),却因为这一条又整包下了 198 MB。
 * 单段模式下相邻的变化块上游已经并成一段(downloadPlanBuilder),那一次是 59 个请求,依次发。
 */
export function updateFeedOptions(
  channel: UpdateChannel,
  platform: NodeJS.Platform,
): { provider: 'generic'; url: string; channel: string; useMultipleRangeRequest: false } | null {
  const url = updateFeedUrl(channel)
  const name = updateChannelName(channel, platform)
  if (url === null || name === null) return null
  return { provider: 'generic', url, channel: name, useMultipleRangeRequest: false }
}

/** @deprecated 保留给仍然直指正式源的调用点(dmg 下载的 base)。新代码用 updateFeedUrl(channel)。 */
export const STABLE_UPDATE_FEED_URL: string = feeds.stable

/**
 * @@@5813 更新说明的家是**官网的帮助中心**,不是下载站,更不是这个仓。
 *
 * 在这之前内容住在 gugu 仓的 changelog/<版本>.json 里,由一条自建流水线合成 changelog.json
 * 传到下载站。那是**传输格式**,不是内容的家:它没有网址,搜不到、分享不出去、别人没法直接翻,
 * 改一个错字还要过一遍 CI。owner 2026-09-18:「本来应该从一开始就这样做」。
 *
 * 现在内容住在 nmhjklnm/gugu-website 的 content/release-notes/ 下,每条都有自己的网址;
 * 应用读的那份 JSON 是那个站的构建产物,应用只是它的读者之一。
 *
 * **按端取**:站上每个端一条自己的版本线(owner:「本来应该是 不同端不同的发布版本来着」),
 * 所以地址里带平台。判据取**运行时**的 process.platform,❌ 不在构建期烘进去 ——
 * 同一份渲染层产物会被 mac 与 windows 两个包共用,烘进去必然有一边是错的。
 */
export const SITE_URL: string = feeds.site

/** 运行平台 → 帮助中心里那一段。认不出的返回 null,调用方据此关掉这件事,❌ 不猜一个端。 */
export function releaseNotesPlatform(platform: string): string | null {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  if (platform === 'android') return 'android'
  return null
}

/** 这个端的发布说明页 —— 弹窗底下那句「在网页上看全部」指的就是它。 */
export function releaseNotesPageUrl(platform: string): string | null {
  const slug = releaseNotesPlatform(platform)
  return slug === null ? null : new URL(`help/release-notes/${slug}/`, SITE_URL).toString()
}

/** 应用真正取的那一份。与页面同源推导 —— 站点改结构时两个地址一起动,不会漂。 */
export function changelogUrl(platform: string): string | null {
  const page = releaseNotesPageUrl(platform)
  return page === null ? null : `${page}changelog.json`
}
