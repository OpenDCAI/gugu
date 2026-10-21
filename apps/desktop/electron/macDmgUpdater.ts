import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import { get as httpGet } from 'node:http'
import { join } from 'node:path'

// @@@663 mac 更新的 dmg 半自动路径:应用内下载 dmg(按架构选 + sha512 校验)→ 下载完自动打开,
// 用户拖装。它的存在理由是 electron-updater 在 macOS 的 downloadUpdate() 只吃 zip(Squirrel.Mac),
// 而当年的发布产物只有 dmg → 点「更新」永远下不到包(6-25 owner 实测卡死,缓存/日志全空)。
//
// @@@5576 这条路径现在是**老包专用的兜底**,不再是所有 mac 用户的主路。两件事变了:
//  ① #4831(2026-09-03)接上 Developer ID 签名与公证,新包不再是 ad-hoc;
//  ② #5576 给 mac 补了 zip 产物,Squirrel 原生静默更新因此可用。
// 但判据**不能**只看「feed 里有没有 zip」:那样一补 zip 就把所有人切到 Squirrel,而 Squirrel 要求
// 新包满足**旧包的** designated requirement —— 存量 ad-hoc 老包(≤ v0.2.35)的 DR 绑死在 cdhash 上,
// Developer ID 新包必然不满足,他们的更新会**静默失败**。所以判据换轴成「**本地这个包自己**是不是
// Developer ID 签名」:老包继续走这条 dmg 路(行为零变化),签名包走 Squirrel 静默。

export interface UpdateFileEntry {
  url: string
  sha512?: string
}

/** 本地运行包的签名身份。判不出一律按 'other' —— 保守回落到 dmg 路径,绝不赌 Squirrel 能过。 */
export type LocalSigning = 'developer-id' | 'other'

/**
 * 该不该走 dmg 半自动路径。纯函数,两条独立的必要条件各挡一种失败:
 *  - feed 里没有 zip → Squirrel 无包可下(老问题)
 *  - 有 zip 但本地是 ad-hoc 老包 → Squirrel 的 DR 校验必不过(@@@5576)
 */
export function shouldUseDmgPath(
  files: UpdateFileEntry[] | undefined,
  localSigning: LocalSigning
): boolean {
  if (!files || files.length === 0) return false
  if (!files.some((f) => f.url.endsWith('.zip'))) return true
  return localSigning !== 'developer-id'
}

/**
 * 问系统:appPath 这个包是不是 Developer ID 签名。判据取 codesign 的 Authority 行 —— ad-hoc 包
 * 那里是 `Signature=adhoc`,没有任何 Authority。codesign 把这些写在 **stderr**。
 * 任何异常(命令缺失/超时/非零退出/解析不出)都归 'other':宁可让签名包多走一次 dmg 路径(只是少了
 * 静默),也不能让 ad-hoc 老包被误判进 Squirrel(那是静默卡死)。
 */
export function detectLocalSigning(appPath: string): LocalSigning {
  // ⚠️ 必须用 spawnSync 而不是 execFileSync:codesign 把 Authority 行写 **stderr**,而 execFileSync
  // 只返回 stdout —— 那样零退出码的签名包会被读成空串、误判成 'other'。
  const res = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], {
    encoding: 'utf8',
    timeout: 10_000
  })
  if (res.error) return 'other'
  return parseCodesignAuthority(`${res.stderr ?? ''}\n${res.stdout ?? ''}`)
}

/** codesign 的输出里出现 Developer ID Application 授权链才算数。 */
export function parseCodesignAuthority(output: string): LocalSigning {
  return /^Authority=Developer ID Application:/m.test(output) ? 'developer-id' : 'other'
}

/** 按运行架构选 dmg(仅认 arm64/x64,别的架构直接报错,不猜)。找不到就报错停(fail loud)。 */
export function pickMacDmgFile(files: UpdateFileEntry[], arch: string): UpdateFileEntry {
  if (arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`不支持的架构 ${arch}(mac 产物只有 arm64/x64)`)
  }
  const match = files.find((f) => f.url.endsWith(`-${arch}.dmg`))
  if (!match) {
    throw new Error(`更新清单里没有 ${arch} 架构的 dmg(files: ${files.map((f) => f.url).join(', ')})`)
  }
  return match
}

// @@@2177 曾有 readFeedBaseUrl():从打包内 app-update.yml 读 feed base。自 #2177 起自动更新源恒为
// 稳定 feed(main.ts setFeedURL 覆盖打包值),dmg 下载必须用同一个 base,再读打包值只会指向 beta 目录
// → 已删除,base 由 updateFeeds.ts 的 STABLE_UPDATE_FEED_URL 单点提供。

/**
 * 下载 dmg 到 destDir 并做 sha512(base64) 校验;校验不过删文件报错。返回落盘路径。
 * 跟随一次 3xx 重定向(OSS/CDN 常见)。
 */
export async function downloadDmg(opts: {
  fileUrl: string
  expectedSha512?: string
  destDir: string
  onProgress?: (received: number, total: number) => void
}): Promise<string> {
  const name = opts.fileUrl.split('/').pop() ?? 'gugu-update.dmg'
  const dest = join(opts.destDir, name)
  // tmp 名带随机段:同进程并发两次下载(双击/双窗口)不得互踩同一 part 文件
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.part`

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const request = (url: string, redirectsLeft: number) => {
      const getter = url.startsWith('http://') ? httpGet : httpsGet
      getter(url, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume()
          request(new URL(res.headers.location, url).toString(), redirectsLeft - 1)
          return
        }
        if (status !== 200) {
          res.resume()
          rejectPromise(new Error(`下载失败 HTTP ${status}: ${url}`))
          return
        }
        const total = Number(res.headers['content-length'] ?? 0)
        const hash = createHash('sha512')
        const out = createWriteStream(tmp)
        let received = 0
        res.on('data', (chunk: Buffer) => {
          hash.update(chunk)
          received += chunk.length
          opts.onProgress?.(received, total)
        })
        res.on('error', rejectPromise)
        out.on('error', rejectPromise)
        res.pipe(out)
        out.on('finish', () => {
          const digest = hash.digest('base64')
          // != null(而非 truthiness):feed 给了 sha512 字段就必须匹配——空串也是「给了但无效」,
          // 一样拒绝,不得静默跳过校验。只有字段缺席才跳过。
          if (opts.expectedSha512 != null && digest !== opts.expectedSha512) {
            rejectPromise(new Error(`sha512 校验失败: 期望 ${opts.expectedSha512} 实得 ${digest}`))
            return
          }
          resolvePromise()
        })
      }).on('error', rejectPromise)
    }
    request(opts.fileUrl, 3)
  }).catch(async (err) => {
    await rm(tmp, { force: true })
    throw err
  })

  await rename(tmp, dest)
  return dest
}
