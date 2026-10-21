// Pin and verify the installer engine at build time; desktop users never need to bootstrap it online.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultMiseCacheDir, DEFAULT_MISE_DOWNLOAD_BASE, obtainMiseArchive } from './mise-archive-cache.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const release = JSON.parse(readFileSync(join(root, 'apps/desktop/src/session/shared/core/agents/mise-release.json'), 'utf8'))
const value = (flag, fallback) => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback
const platform = value('--platform', process.platform)
const arch = value('--arch', process.arch)
const target = release.assets[platform + '-' + arch]
if (!target) throw new Error('No pinned mise distribution for ' + platform + '-' + arch)
const osName = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform]
const destination = join(root, 'mise-bundle', osName + '-' + arch)
const executable = join(destination, 'mise', 'bin', platform === 'win32' ? 'mise.exe' : 'mise')
const stamp = JSON.stringify({ version: release.version, sha256: target.sha256 })

if (existsSync(executable) && existsSync(join(destination, 'release.json')) && readFileSync(join(destination, 'release.json'), 'utf8') === stamp) {
  console.log('[build-mise] pinned bundle already present: ' + platform + '-' + arch)
} else {
  mkdirSync(join(root, 'mise-bundle'), { recursive: true })
  const temporary = mkdtempSync(join(root, 'mise-bundle', '.staging-'))
  try {
    // 归档来自按 sha256 内容寻址的缓存(#6258,见 mise-archive-cache.mjs);未命中才下载,拿不到就响亮失败。
    const archive = obtainMiseArchive({
      cacheDir: defaultMiseCacheDir(),
      downloadBase: process.env.GUGU_MISE_DOWNLOAD_BASE || DEFAULT_MISE_DOWNLOAD_BASE,
      version: release.version,
      asset: target.asset,
      sha256: target.sha256,
    })
    const extracted = join(temporary, 'extracted')
    mkdirSync(extracted)
    if (target.asset.endsWith('.zip') && process.platform !== 'win32') {
      execFileSync('unzip', ['-q', archive, '-d', extracted], { stdio: 'inherit' })
    } else {
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
      execFileSync(tar, ['-xf', archive, '-C', extracted], { stdio: 'inherit' })
    }
    const binary = join(extracted, 'mise', 'bin', platform === 'win32' ? 'mise.exe' : 'mise')
    if (!existsSync(binary)) throw new Error('mise distribution is missing its executable')
    if (platform === 'win32' && !existsSync(join(extracted, 'mise/bin/mise-shim.exe'))) throw new Error('mise distribution is missing mise-shim.exe')
    chmodSync(binary, 0o755)
    writeFileSync(join(extracted, 'release.json'), stamp)
    mkdirSync(dirname(destination), { recursive: true })
    rmSync(destination, { recursive: true, force: true })
    renameSync(extracted, destination)
    console.log('[build-mise] bundled v' + release.version + ' for ' + platform + '-' + arch)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
