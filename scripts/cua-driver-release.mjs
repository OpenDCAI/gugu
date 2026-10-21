// #7199 「电脑控制」用的 cua-driver(github.com/trycua/cua,MIT):Mac 与 Windows 包都带它的发布二进制。
// 钉版本与三个 sha256 的唯一地方;升级 = 改 VERSION 与 SHA256(说明见 apps/desktop/native/cua-driver/README.md)。
// 归档按「sha256/文件名」缓存在 node_modules/.cache/gugu-native/,命中且校验通过就不联网;
// 下载用 curl(认 HTTPS_PROXY);本仓维护包走 GitHub API,带 GH_TOKEN 鉴权;校验对不上就报错退出,❌ 兜底。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const CUA_DRIVER_VERSION = '0.36.0'
export const CUA_DRIVER_MAC_REVISION = '0.36.0-gugu.1'
const SHA256 = {
  'darwin-universal': '3a9e5ddfc3078bdc09ab1eb708d8bc49964a306b31f0251689fda8da69fae9c6',
  'win32-x64': 'f8c47024b626f4e0e70f8428d2998df39e4879110c5722a29d5fd03e367353ad',
  'win32-arm64': '520ea584cf11c074bccc4fd2328e8f2b34ec43de9328d97afb7fd03f761b55ee',
}
const ASSET = {
  'darwin-universal': `cua-driver-rs-${CUA_DRIVER_MAC_REVISION}-darwin-universal-binary.tar.gz`,
  'win32-x64': `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`,
  'win32-arm64': `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-arm64-binary.zip`,
}
const BASE_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/`
// The maintained Mac archive is an immutable asset of this private repository's `assets` release.
// Its asset id is pinned with its sha256: private release downloads only accept a token on the API asset URL.
const MAC_ASSET_ID = 656807118
const MAC_ASSET_API = 'https://api.github.com/repos/nmhjklnm/gugu/releases/assets/'
const CACHE_DIR = path.join(root, 'node_modules', '.cache', 'gugu-native')
const LICENSE_DIR = path.join(root, 'apps', 'desktop', 'native', 'cua-driver')

const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function curl(args) {
  const bin = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe') : 'curl'
  execFileSync(bin, ['-fL', '--retry', '3', '--silent', '--show-error', '--connect-timeout', '15', ...args], { stdio: 'inherit' })
}

function curlDownload(url, destination) {
  if (!url.startsWith(MAC_ASSET_API)) {
    curl(['--output', destination, url])
    return
  }
  // curl expands GH_TOKEN from its own environment (curl >= 8.3), so the token never enters argv;
  // curl drops the header on the redirect to the storage host.
  if (!process.env.GH_TOKEN) throw new Error('[cua-driver] 下载本仓维护包要 GH_TOKEN(开发机:GH_TOKEN=$(gh auth token) node …;CI 由构建步骤传 github.token)')
  curl(['--variable', '%GH_TOKEN', '--expand-header', 'Authorization: Bearer {{GH_TOKEN}}', '-H', 'Accept: application/octet-stream', '--output', destination, url])
}

/** 返回缓存里校验过的归档路径。命中且 sha256 对得上就不调用 `download`;对不上(截断/被改)就丢掉重拿。 */
export function obtainVerifiedArchive({ url, asset, sha256, cacheDir = CACHE_DIR, download = curlDownload, log = console.log, warn = console.error }) {
  const cached = path.join(cacheDir, sha256, asset)
  if (fs.existsSync(cached)) {
    if (sha256Of(cached) === sha256) {
      log(`[cua-driver] 缓存命中 ${cached}`)
      return cached
    }
    warn(`[cua-driver] 缓存里的 ${asset} sha256 不对,丢掉重下:${cached}`)
    fs.rmSync(cached, { force: true })
  }
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  const partial = `${cached}.${process.pid}.part`
  try {
    download(url, partial)
  } catch (error) {
    fs.rmSync(partial, { force: true })
    throw new Error(`[cua-driver] 下载失败 ${url}(${error?.status !== undefined ? `curl exit ${error.status}` : String(error?.message ?? error)})`, { cause: error })
  }
  const actual = sha256Of(partial)
  if (actual !== sha256) {
    fs.rmSync(partial, { force: true })
    throw new Error(`[cua-driver] ${asset} 的 sha256 是 ${actual},钉住的是 ${sha256}(来源 ${url})`)
  }
  fs.renameSync(partial, cached) // 内容寻址:并发的两次构建谁先放好都对
  log(`[cua-driver] 已下载 ${url} → ${cached}`)
  return cached
}

/** Pinned distribution identity: macOS uses the maintained source revision; Windows uses upstream. */
export function cuaDriverArchiveInfo(key) {
  if (!SHA256[key]) throw new Error(`[cua-driver] 没有钉 ${key} 的发布包`)
  return { url: key === 'darwin-universal' ? MAC_ASSET_API + MAC_ASSET_ID : BASE_URL + ASSET[key], asset: ASSET[key], sha256: SHA256[key] }
}

/** key:darwin-universal / win32-x64 / win32-arm64。 */
export function obtainCuaDriverArchive(key) {
  return obtainVerifiedArchive(cuaDriverArchiveInfo(key))
}

/** 只从归档里取一个文件,放进 dir。 */
export function extractOne(archive, member, dir) {
  fs.mkdirSync(dir, { recursive: true })
  if (archive.endsWith('.zip') && process.platform !== 'win32') {
    execFileSync('unzip', ['-q', '-o', archive, member, '-d', dir], { stdio: 'inherit' })
  } else {
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    execFileSync(tar, ['-xf', archive, '-C', dir, member], { stdio: 'inherit' })
  }
  const file = path.join(dir, member)
  if (!fs.existsSync(file)) throw new Error(`[cua-driver] ${path.basename(archive)} 里没有 ${member}`)
  return file
}

/** PE 头的 Machine 字段:x64 = 0x8664,arm64 = 0xAA64。 */
export function assertPeMachine(file, arch) {
  const want = { x64: 0x8664, arm64: 0xaa64 }[arch]
  const buf = fs.readFileSync(file)
  const pe = buf.length >= 0x40 ? buf.readUInt32LE(0x3c) : -1
  const ok = pe > 0 && buf.length >= pe + 6 && buf.toString('latin1', pe, pe + 4) === 'PE\0\0'
  const machine = ok ? buf.readUInt16LE(pe + 4) : -1
  if (machine !== want) throw new Error(`[cua-driver] ${file} 的 PE Machine 是 0x${machine.toString(16)},不是 ${arch}(0x${want.toString(16)})`)
}

/** 跑 cua-driver 的环境:干净(只留系统必需的几项)、嵌入模式、不发遥测、不查更新、家目录在临时目录(❌ 写 ~/.cua-driver)。 */
function cuaDriverEnv(home) {
  // Windows 上没有 SystemRoot 的进程连网络栈/加密库都初始化不了,所以那边多留 SystemRoot / TEMP / TMP / USERPROFILE。
  const keep = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE'])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key.toUpperCase())))
  return {
    ...env,
    CUA_DRIVER_EMBEDDED: '1',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
    CUA_DRIVER_RS_HOME: home,
  }
}

/** 校验 `dump-docs --type mcp` 的输出({ tools: [{ name, description, input_schema, … }], version }),原样返回要写进 cua-tools.json 的文本。 */
export function parseCuaTools(text, version = CUA_DRIVER_VERSION) {
  const doc = JSON.parse(text)
  if (doc.version !== version) throw new Error(`[cua-driver] dump-docs 报的版本是 ${doc.version},钉住的是 ${version}`)
  if (!Array.isArray(doc.tools) || doc.tools.length === 0) throw new Error('[cua-driver] dump-docs 的工具清单是空的')
  const unnamed = doc.tools.filter((tool) => typeof tool?.name !== 'string' || !tool.name)
  if (unnamed.length > 0) throw new Error(`[cua-driver] dump-docs 里有 ${unnamed.length} 个工具没有 name`)
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 用这台机器能跑的 cua-driver 导出工具清单(`dump-docs --type mcp`,不要任何系统授权),先核版本。 */
export function exportCuaTools(binary) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cua-home-'))
  try {
    const options = { env: cuaDriverEnv(home), encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
    const reported = execFileSync(binary, ['--version'], options).trim()
    if (reported !== `cua-driver ${CUA_DRIVER_VERSION}`) throw new Error(`[cua-driver] ${binary} --version 报「${reported}」,钉住的是 ${CUA_DRIVER_VERSION}`)
    return parseCuaTools(execFileSync(binary, ['dump-docs', '--type', 'mcp'], options))
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** 许可证随二进制走:cua 仓根的 MIT 与 cua-driver 的第三方声明。 */
export function copyCuaLicenses(out) {
  fs.copyFileSync(path.join(LICENSE_DIR, 'LICENSE.md'), path.join(out, 'CUA-DRIVER-LICENSE.md'))
  fs.copyFileSync(path.join(LICENSE_DIR, 'THIRD_PARTY_NOTICES.md'), path.join(out, 'CUA-DRIVER-THIRD-PARTY-NOTICES.md'))
}
