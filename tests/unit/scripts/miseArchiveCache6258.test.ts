import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_MISE_DOWNLOAD_BASE, defaultMiseCacheDir, obtainMiseArchive } from '../../../scripts/mise-archive-cache.mts'

// #6258 桌面构建内置的 mise 归档:按入库 sha256 内容寻址缓存,命中不访问网络;拿不到响亮失败并报出来源。
const CONTENT = 'fake mise archive bytes'
const SHA = createHash('sha256').update(CONTENT).digest('hex')
const ASSET = 'mise-v2026.9.12-macos-arm64.tar.gz'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function cacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-6258-'))
  roots.push(dir)
  return dir
}
const quiet = { log: () => {}, warn: () => {} }

describe('#6258 mise archive cache', () => {
  it('未命中:从来源拿一次、按 sha256/文件名 落缓存;再取即命中,不再访问网络', () => {
    const dir = cacheDir()
    const calls: string[] = []
    const download = (url: string, destination: string) => {
      calls.push(url)
      writeFileSync(destination, CONTENT)
    }
    const input = { cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, download, ...quiet }
    const first = obtainMiseArchive(input)
    expect(first).toBe(join(dir, SHA, ASSET))
    expect(calls).toEqual([`${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET}`])
    expect(obtainMiseArchive(input)).toBe(first)
    expect(calls).toHaveLength(1)
    expect(readdirSync(join(dir, SHA))).toEqual([ASSET]) // 没有 .part 残留
  })

  it('下载源可换(镜像),但只认入库的 sha256', () => {
    const dir = cacheDir()
    const calls: string[] = []
    obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA, downloadBase: 'https://mirror.example/mise/',
      download: (url, destination) => { calls.push(url); writeFileSync(destination, CONTENT) }, ...quiet,
    })
    expect(calls).toEqual([`https://mirror.example/mise/v2026.9.12/${ASSET}`])
  })

  it('缓存坏了:丢弃、说出来、按 sha256 重拿', () => {
    const dir = cacheDir()
    mkdirSync(join(dir, SHA))
    writeFileSync(join(dir, SHA, ASSET), 'truncated')
    const warnings: string[] = []
    let downloads = 0
    const path = obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA,
      download: (_url, destination) => { downloads += 1; writeFileSync(destination, CONTENT) },
      log: () => {}, warn: (line) => warnings.push(line),
    })
    expect(downloads).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe(CONTENT)
    expect(warnings[0]).toMatch(/failed SHA-256, discarding/)
  })

  it('拿不到就响亮失败并报出来源;缓存里不留半截', () => {
    const dir = cacheDir()
    const brokenPipe = Object.assign(new Error('Command failed: curl'), { status: 55 })
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA,
      download: (_url, destination) => { writeFileSync(destination, 'partial'); throw brokenPipe }, ...quiet,
    })).toThrow(`[build-mise] download failed from ${DEFAULT_MISE_DOWNLOAD_BASE}/v2026.9.12/${ASSET} (curl exit 55)`)
    expect(existsSync(join(dir, SHA, ASSET))).toBe(false)
    expect(readdirSync(join(dir, SHA))).toEqual([])
  })

  it('来源给了别的内容 ⇒ 响亮失败(报来源与两个 sha),不入缓存', () => {
    const dir = cacheDir()
    expect(() => obtainMiseArchive({
      cacheDir: dir, version: '2026.9.12', asset: ASSET, sha256: SHA,
      download: (_url, destination) => writeFileSync(destination, 'tampered'), ...quiet,
    })).toThrow(/SHA-256 mismatch .* from https:\/\/github\.com\/jdx\/mise\/releases\/download\/v2026\.9\.12\/.*pinned/)
    expect(existsSync(join(dir, SHA, ASSET))).toBe(false)
  })

  it('缓存位置:CI 用 GUGU_MISE_CACHE_DIR,否则落在 XDG 缓存下', () => {
    expect(defaultMiseCacheDir({ GUGU_MISE_CACHE_DIR: '/ci/shared/mise', XDG_CACHE_HOME: '/x' })).toBe('/ci/shared/mise')
    expect(defaultMiseCacheDir({ XDG_CACHE_HOME: '/x' })).toBe(join('/x', 'gugu', 'mise'))
  })
})
