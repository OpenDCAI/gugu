// Optional legacy codex-acp bundle (GUGU_ACP_BUNDLE=full); thin is the default.
// Claude's JavaScript bridge is already a production dependency. Its native CLI is never
// fetched or bundled here: the harness installer supplies the host's own installation.
//
// 为什么是构建期 fetch（非 package.json dependency）：
//   codex-acp 的平台原生 bin（@zed-industries/codex-acp-<platform>-<arch>）单个 ~230MB。做常规依赖则
//   每次 `pnpm install`（含 CI quality job / 每个开发者）都拉一份，太重。改成**只在打包时**（build:mac/
//   win/linux → build:app）按构建目标平台拉一次，放进 acp-bundle/，由 electron-builder extraResources
//   带到 Resources/acp/。CI 的 build:renderer 不走 build:app → 不受 230MB 影响。
//
// Bundle layout:
//   acp-bundle/node_modules/@zed-industries/
//     codex-acp/bin/codex-acp.js              ← JS wrapper（被 resolveNodeBin 用 node 跑）
//     codex-acp-<platform>-<arch>/bin/codex-acp ← 平台原生 bin（wrapper 经 import.meta.resolve 找同级）
//   → extraResources `{from:'acp-bundle', to:'acp'}` → Resources/acp/node_modules/@zed-industries/...
//
// 平台/架构默认构建主机；cross-build 用 GUGU_BUILD_PLATFORM / GUGU_BUILD_ARCH 覆盖（对齐 electron-builder target）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, renameSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

// #1478 PR-C/C3：构建档位。默认 thin（薄包，不内置运行时）；GUGU_ACP_BUNDLE=full 才内置（兜底档）。
const BUNDLE_MODE = (process.env.GUGU_ACP_BUNDLE || 'thin').toLowerCase()
if (BUNDLE_MODE !== 'full' && BUNDLE_MODE !== 'thin') {
  console.error(`[fetch-acp] FAIL: GUGU_ACP_BUNDLE 仅支持 thin|full，收到 ${JSON.stringify(BUNDLE_MODE)}`)
  process.exit(1)
}
if (BUNDLE_MODE === 'thin') {
  // 薄包：清掉可能残留的 full 产物（避免上次 full 构建的 acp-bundle/ 被 electron-builder 误带），直接退出。
  const bundleDir = join(REPO_ROOT, 'acp-bundle')
  // 显式提示「正在清掉已存在的 full 产物」——否则 full-then-thin 连跑会静默删掉刚构建的兜底包（review #2）。
  if (existsSync(bundleDir)) {
    console.warn('[fetch-acp] thin 包：检测到已存在的 acp-bundle/（可能是上次 full 构建产物）→ 清除。要保留请用 GUGU_ACP_BUNDLE=full。')
  }
  rmSync(bundleDir, { recursive: true, force: true })
  console.log('[fetch-acp] thin 包（默认）：不内置原生 ACP 运行时。')
  process.exit(0)
}
console.log('[fetch-acp] full 包（GUGU_ACP_BUNDLE=full）：仅内置 codex-acp 运行时。')

const VERSION = process.env.GUGU_CODEX_ACP_VERSION || '0.16.0'
const platform = process.env.GUGU_BUILD_PLATFORM || process.platform // 'darwin' | 'linux' | 'win32'
const arch = process.env.GUGU_BUILD_ARCH || process.arch // 'arm64' | 'x64'

const WRAPPER_PKG = '@zed-industries/codex-acp'
const NATIVE_PKG = `@zed-industries/codex-acp-${platform}-${arch}`

const SCOPE_DIR = join(REPO_ROOT, 'acp-bundle', 'node_modules', '@zed-industries')

/** `npm pack <pkg>@<ver>` 下 tarball（尊重 npm registry/proxy 配置）→ tar 解到 destParent/<dirName>。 */
function fetchPackageInto(pkg, version, destParent, dirName) {
  const tmp = join(REPO_ROOT, 'acp-bundle', '.tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  // npm pack 输出 tarball 名（去 scope / @ → -）。
  const out = execFileSync('npm', ['pack', `${pkg}@${version}`, '--pack-destination', tmp], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  const tgz = out.trim().split('\n').pop().trim()
  // tar 解出顶层 package/；解到临时再整体搬到目标 dirName（保留文件可执行位）。
  execFileSync('tar', ['-xzf', join(tmp, tgz), '-C', tmp], { cwd: REPO_ROOT })
  const dest = join(destParent, dirName)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(destParent, { recursive: true })
  renameSync(join(tmp, 'package'), dest)
  rmSync(tmp, { recursive: true, force: true })
  return dest
}

console.log(`[fetch-acp] codex-acp@${VERSION} for ${platform}-${arch}`)
rmSync(join(REPO_ROOT, 'acp-bundle'), { recursive: true, force: true })
const wrapperDir = fetchPackageInto(WRAPPER_PKG, VERSION, SCOPE_DIR, 'codex-acp')
const nativeDir = fetchPackageInto(NATIVE_PKG, VERSION, SCOPE_DIR, `codex-acp-${platform}-${arch}`)

// 校验布局：wrapper 入口 + 原生 bin 都在，且 wrapper 真能经 import.meta.resolve 找到原生 bin。
const wrapperEntry = join(wrapperDir, 'bin', 'codex-acp.js')
const nativeBinName = platform === 'win32' ? 'codex-acp.exe' : 'codex-acp'
const nativeBin = join(nativeDir, 'bin', nativeBinName)
for (const [label, p] of [['wrapper', wrapperEntry], ['native bin', nativeBin]]) {
  if (!existsSync(p)) {
    console.error(`[fetch-acp] FAIL: ${label} 缺失：${p}`)
    process.exit(1)
  }
}
// npm pack 的 tarball 里原生 bin 是 644（`npm install` 才 chmod +x，手动 pack+tar 不会）→ 显式补可执行位，
// 否则 wrapper spawnSync 原生 bin 会 EACCES（已 Linux 实测复现）。win32 不需要（.exe 靠扩展名）。
if (platform !== 'win32') chmodSync(nativeBin, 0o755)
console.log(`[fetch-acp] ok：${SCOPE_DIR} 下 ${readdirSync(SCOPE_DIR).join(', ')}`)
