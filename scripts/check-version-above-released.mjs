#!/usr/bin/env node
// @@@version-above-released — 仓库当前 version 必须**严格大于**线上已发布的稳定版。
//
// 为什么要一道门(原因):当年 beta 与正式包查的是**同一条稳定 feed**,于是 package.json 的 base
// 一旦落到线上稳定版之下,出的 beta 包(`<base>-beta.<run>.<attempt>`)在 semver 上小于线上正式版,
// 装了 beta 的人一开机就被提示「更新」到正式包 —— dogfood 通道把测试者推离他们要测的那份代码。
//
// ⚠️ @@@5737 起这条原因**不再成立**:beta 追 beta、正式追正式,两条通道互不可见,beta 包不会再被
// 正式 feed 提示。这道门保留是为了另一件仍然成立的事 —— 版本号只能向前:base 落回线上已发布版之下,
// 意味着 dev 忘了「发完立刻开下一个版本号」(docs/cd-runbook.md 第 5 条),而那会让 beta 之间
// 也排不出先后(同一个 base 下靠 run number 分)。判据不变,理由换了。
//
// 这个失败是**无声的**:构建全绿、包能装、feed 自洽,只有装的人看见一个更新提示,
// 而那个提示看上去完全正常。实际发生过:dev 自 2026-08-17 起停在 0.2.31,期间 main 上
// bump 过 0.2.32 / 0.2.33 并发了版;而 promotion 的模型是「main 只接 exact dev promotion」
// (docs/deploy-migrations-setup.md),每次 promote 都把 main 的版本又拽回 dev 的 0.2.31。
// 换句话说:**版本 bump 打在 main 上注定被下一次 promotion 抹掉**,只有打在 dev 上才留得住。
//
// 为什么是严格大于、不是 >=:base 等于线上版时,`<base>-beta.N` 在 semver 上仍然**小于**
// `<base>`(预发布段永远排在正式版之前)。所以发版之后必须立刻在 dev 上开下一个版本号,
// 否则下一批 beta 又会掉到线上正式版之下 —— 这正是本门要说出来的那句话。
//
// 判据取「线上 feed 真实报的版本」而不是 git tag:tag 存在不等于发布成功过(单平台失败连坐、
// 传了一半的 feed 都会让两者分叉),而用户实际会被推去更新的,只有 feed 里那个版本。

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(import.meta.dirname, '..')

/**
 * 解析 semver 核心三段 + 可选预发布段。认不出返回 null(由调用方决定怎么处置),
 * ❌ 不猜:版本号形状不对时静默当成 0.0.0 会让门在最该说话的时候放行。
 */
export function parseSemver(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^v/i, '')
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(trimmed)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  }
}

/**
 * 比较两个版本的核心三段:a > b 返回正数,相等 0,a < b 负数。
 * ⚠️ 必须逐段**按数字**比 —— 字符串比会得出 "0.2.9" > "0.2.33" 这种反向结论,
 * 而 patch 跨过 9 正是这仓当前所在的区间。
 */
export function compareCore(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left) throw new Error(`版本号形状不对,无法比较: ${JSON.stringify(a)}`)
  if (!right) throw new Error(`版本号形状不对,无法比较: ${JSON.stringify(b)}`)
  return (
    left.major - right.major || left.minor - right.minor || left.patch - right.patch
  )
}

/** 本地版本的核心三段是否严格大于线上已发布版本。预发布段不参与判断(见文件头)。 */
export function isAboveReleased(localVersion, releasedVersion) {
  return compareCore(localVersion, releasedVersion) > 0
}

/**
 * 从 electron-updater 的 mac feed(YAML)里取 `version:`。只认顶层第一条,
 * ❌ 不引 YAML 依赖:这个文件的形状由 scripts/normalize-mac-feed.cjs 规定,稳定且极简。
 */
export function readFeedVersion(yamlText) {
  if (typeof yamlText !== 'string') return null
  const match = /^version:\s*(\S+)\s*$/m.exec(yamlText)
  return match ? match[1] : null
}

/** 稳定 feed 的 latest-mac.yml 地址 —— 与客户端读同一份 updateFeeds.json,改域名不会漂。 */
export function stableFeedUrl(rootDir = repoRoot) {
  const feeds = JSON.parse(
    readFileSync(join(rootDir, 'apps/desktop/electron/updateFeeds.json'), 'utf8')
  )
  if (typeof feeds.stable !== 'string' || !feeds.stable) {
    throw new Error('updateFeeds.json 缺 stable feed —— 无法判断线上版本')
  }
  return `${feeds.stable.replace(/\/$/, '')}/latest-mac.yml`
}

export function readLocalVersion(rootDir = repoRoot) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string') {
    throw new Error('package.json 的 version 字段缺失或不是字符串')
  }
  return pkg.version
}

async function main() {
  const local = readLocalVersion()
  const url = stableFeedUrl()

  let yamlText
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    yamlText = await response.text()
  } catch (error) {
    // 读不到 feed **不判红**:CDN 抖一下就把整条 beta 通道打红,是拿 flake 换保障。
    // 但也绝不静默 —— 说清楚这一次没能核对,以及没核对的是什么。
    console.log(`::warning::取不到线上稳定 feed(${url}): ${error.message}`)
    console.log(`::warning::本次**未核对**「version(${local}) > 线上已发布版本」,门被跳过。`)
    return 0
  }

  const released = readFeedVersion(yamlText)
  if (!released) {
    console.error(`::error::线上稳定 feed 里读不到 version 字段(${url})——feed 形状不对,拒绝继续。`)
    return 1
  }

  console.log(`本地 version: ${local} / 线上已发布稳定版: ${released}`)
  if (isAboveReleased(local, released)) {
    console.log('version order OK')
    return 0
  }

  console.error(
    `::error file=package.json::package.json 的 version(${local})不高于线上已发布的稳定版(${released})。` +
      `出的 beta 包会是 ${parseSemver(local)?.major}.${parseSemver(local)?.minor}.${parseSemver(local)?.patch}-beta.N,` +
      `semver 上小于 ${released} —— 装了 beta 的人会被提示「更新」到正式包,dogfood 通道自己把自己顶掉。`
  )
  console.error(
    '::error::修法:在 **dev** 上把 package.json 的 version 提到高于线上版(bump 打在 main 上会被下一次 promotion 抹掉)。'
  )
  return 1
}

// 被 import 时不执行(单测要用上面那些纯函数)。
// ⚠️ 用 fileURLToPath 而不是 `file://${argv[1]}` 拼接:路径里有空格/中文时 URL 是百分号编码的,
// 拼出来的串永远对不上 —— 这仓到处是中文文件名,check-file-url-paths.mjs 专门钉这条。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(await main())
}
