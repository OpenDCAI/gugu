// 远程隧道的中转客户端 frpc(fatedier/frp,Apache-2.0):构建时按 frpc-release.json 钉的版本与 sha256 取一份,
// 放进 frpc-bundle/<os>-<arch>/。桌面包经 electron-builder 的 extraResources 带上,server 包由 build-gugu-server.mjs 拷进去。
// 归档走与 mise 同一个内容寻址缓存(mise-archive-cache.mjs):拿过一次就不再联网;拿不到就响亮失败,❌ 换来源兜底。
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultMiseCacheDir, obtainMiseArchive } from './mise-archive-cache.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const release = JSON.parse(readFileSync(join(root, 'scripts', 'frpc-release.json'), 'utf8'))
const value = (flag, fallback) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback)
const platform = value('--platform', process.platform)
const arch = value('--arch', process.arch)
const target = release.assets[`${platform}-${arch}`]
if (!target) throw new Error(`frpc-release.json 里没有 ${platform}-${arch}`)
const osName = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform]
const exe = platform === 'win32' ? 'frpc.exe' : 'frpc'
const destination = join(root, 'frpc-bundle', `${osName}-${arch}`)
const stamp = JSON.stringify({ version: release.version, sha256: target.sha256 })

if (existsSync(join(destination, exe)) && existsSync(join(destination, 'release.json')) && readFileSync(join(destination, 'release.json'), 'utf8') === stamp) {
  console.log(`[build-frpc] pinned frpc already present: ${platform}-${arch}`)
} else {
  const archive = obtainMiseArchive({
    cacheDir: defaultMiseCacheDir(),
    downloadBase: process.env.GUGU_FRPC_DOWNLOAD_BASE || 'https://github.com/fatedier/frp/releases/download',
    version: release.version,
    asset: target.asset,
    sha256: target.sha256,
  })
  mkdirSync(join(root, 'frpc-bundle'), { recursive: true })
  const temporary = mkdtempSync(join(root, 'frpc-bundle', '.staging-'))
  try {
    if (target.asset.endsWith('.zip')) {
      if (process.platform === 'win32') {
        execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', temporary], { stdio: 'inherit' })
      } else {
        execFileSync('unzip', ['-q', archive, '-d', temporary], { stdio: 'inherit' })
      }
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'inherit' })
    }
    const folder = target.asset.replace(/\.(tar\.gz|zip)$/, '')
    const binary = join(temporary, folder, exe)
    if (!existsSync(binary)) throw new Error(`${target.asset} 里没有 ${folder}/${exe}`)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    copyFileSync(binary, join(destination, exe))
    copyFileSync(join(temporary, folder, 'LICENSE'), join(destination, 'LICENSE'))
    chmodSync(join(destination, exe), 0o755)
    writeFileSync(join(destination, 'release.json'), stamp)
    console.log(`[build-frpc] bundled frpc v${release.version} for ${platform}-${arch}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
