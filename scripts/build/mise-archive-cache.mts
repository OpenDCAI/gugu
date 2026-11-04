// @@@mise-archive-cache (#6258) — 内置 mise 归档按「sha256 / 文件名」内容寻址存一份,命中就不访问网络。
//
// 每次构建现从 github.com 拉一个第三方二进制,一次断连(curl 55 Broken pipe)就把 required 聚合打红;
// 版本与 sha256 早已入库(mise-release.json),缺的是「拿过一次就别再拿」。CI 上由 setup-ci-slot 指到
// 全机共用的 ~/.gugu-ci-shared/mise(16 个槽共一份,理由同 fixture-bin #5360);本地落在 XDG 缓存下。
// 下载源可换(GUGU_MISE_DOWNLOAD_BASE,镜像用),但只认入库的 sha256。拿不到就响亮失败并报出来源,
// ❌ 重试到绿、❌ 换来源兜底。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_MISE_DOWNLOAD_BASE: string = 'https://github.com/jdx/mise/releases/download'

export function defaultMiseCacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.GUGU_MISE_CACHE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'gugu', 'mise')
}

const sha256Of = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

function curlDownload(url: string, destination: string): void {
  execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--speed-limit', '1', '--speed-time', '60', '--output', destination, url], { stdio: 'inherit' })
}

/** 返回校验过的归档路径(在缓存里)。缓存命中不调用 `download`。 */
export function obtainMiseArchive({
  cacheDir,
  downloadBase = DEFAULT_MISE_DOWNLOAD_BASE,
  version,
  asset,
  sha256,
  download = curlDownload,
  log = console.log,
  warn = console.error,
}: {
  cacheDir: string
  downloadBase?: string
  version: string
  asset: string
  sha256: string
  download?: (url: string, destination: string) => void
  log?: (line: string) => void
  warn?: (line: string) => void
}): string {
  const cached = join(cacheDir, sha256, asset)
  if (existsSync(cached)) {
    if (sha256Of(cached) === sha256) {
      log('[build-mise] cache hit ' + cached)
      return cached
    }
    // 缓存坏了(截断/被改)不是「用它凑合」的理由:删掉、说出来,再按入库的 sha256 重拿一份。
    warn('[build-mise] cached archive failed SHA-256, discarding: ' + cached)
    rmSync(cached, { force: true })
  }
  mkdirSync(dirname(cached), { recursive: true })
  const url = downloadBase.replace(/\/+$/, '') + '/v' + version + '/' + asset
  const partial = cached + '.' + process.pid + '.part'
  try {
    download(url, partial)
  } catch (caught) {
    const error = caught as { status?: number; message?: string } | undefined
    rmSync(partial, { force: true })
    throw new Error('[build-mise] download failed from ' + url + ' (' + (error?.status !== undefined ? 'curl exit ' + error.status : String(error?.message ?? error)) + '); nothing cached at ' + cached + ' — no fallback source', { cause: error })
  }
  const actual = sha256Of(partial)
  if (actual !== sha256) {
    rmSync(partial, { force: true })
    throw new Error('[build-mise] SHA-256 mismatch for ' + asset + ' from ' + url + ': got ' + actual + ', pinned ' + sha256)
  }
  // 暂存名再 rename:并发的两次构建谁先放好都对(内容寻址,两份逐字节相同)。
  renameSync(partial, cached)
  log('[build-mise] downloaded ' + url + ' → ' + cached)
  return cached
}
