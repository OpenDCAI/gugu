// #1181 机制层打包 —— 把本地 ACP 适配器（codex）随 app 带，弃用 npx 联网拉包。
//
// #1478 PR-C/C3 薄/full 两档（GUGU_ACP_BUNDLE，默认 thin）：
//   · thin（默认）：**不内置**原生运行时（codex ~230MB + claude ~216MB），只发胶水（app 内的 engine-downloader）。
//     agent 首次启动时由 engine-downloader 按需把运行时拉到用户缓存（接 PR-B；GUGU_ACP_ENABLE_ONDEMAND 默认开）。
//     thin 档清掉 acp-bundle/ 后直接退出 → electron-builder 的 existsSync 守卫自然不带运行时（包瘦 ~446MB）。
//   · full（GUGU_ACP_BUNDLE=full，兜底档）：照旧把运行时拉进 acp-bundle/ → electron-builder 带到 Resources/acp/，
//     运行时命中内置、下载器休眠（离线/无 npm 环境的兜底）。
//
// 为什么是构建期 fetch（非 package.json dependency）：
//   codex-acp 的平台原生 bin（@zed-industries/codex-acp-<platform>-<arch>）单个 ~230MB。做常规依赖则
//   每次 `pnpm install`（含 CI quality job / 每个开发者）都拉一份，太重。改成**只在打包时**（build:mac/
//   win/linux → build:app）按构建目标平台拉一次，放进 acp-bundle/，由 electron-builder extraResources
//   带到 Resources/acp/。CI 的 build:renderer 不走 build:app → 不受 230MB 影响。
//
// 布局（被 engine-downloader.resolveResourcesAdapterEntry 契约依赖，**勿改**）：
//   acp-bundle/node_modules/@zed-industries/
//     codex-acp/bin/codex-acp.js              ← JS wrapper（被 resolveNodeBin 用 node 跑）
//     codex-acp-<platform>-<arch>/bin/codex-acp ← 平台原生 bin（wrapper 经 import.meta.resolve 找同级）
//   → extraResources `{from:'acp-bundle', to:'acp'}` → Resources/acp/node_modules/@zed-industries/...
//
// 平台/架构默认构建主机；cross-build 用 GUGU_BUILD_PLATFORM / GUGU_BUILD_ARCH 覆盖（对齐 electron-builder target）。
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, existsSync, readdirSync, renameSync, chmodSync, cpSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// #1478 PR-C/C3：构建档位。默认 thin（薄包，不内置运行时）；GUGU_ACP_BUNDLE=full 才内置（兜底档）。
const BUNDLE_MODE = (process.env.GUGU_ACP_BUNDLE || 'thin').toLowerCase()
if (BUNDLE_MODE !== 'full' && BUNDLE_MODE !== 'thin') {
  console.error(`[fetch-acp] FAIL: GUGU_ACP_BUNDLE 仅支持 thin|full，收到 ${JSON.stringify(BUNDLE_MODE)}`)
  process.exit(1)
}
if (BUNDLE_MODE === 'thin') {
  // 薄包：清掉可能残留的 full 产物（避免上次 full 构建的 acp-bundle/ 被 electron-builder 误带），直接退出。
  // 运行时由 app 内 engine-downloader 按需拉到用户缓存（见 acp-bridge-impl.resolveAdapterResourcesDir）。
  const bundleDir = join(REPO_ROOT, 'acp-bundle')
  // 显式提示「正在清掉已存在的 full 产物」——否则 full-then-thin 连跑会静默删掉刚构建的兜底包（review #2）。
  if (existsSync(bundleDir)) {
    console.warn('[fetch-acp] thin 包：检测到已存在的 acp-bundle/（可能是上次 full 构建产物）→ 清除。要保留请用 GUGU_ACP_BUNDLE=full。')
  }
  rmSync(bundleDir, { recursive: true, force: true })
  console.log('[fetch-acp] thin 包（默认）：不内置 ACP 运行时；agent 首次启动时按需下载到用户缓存。')
  process.exit(0)
}
console.log('[fetch-acp] full 包（GUGU_ACP_BUNDLE=full）：内置 codex + claude 运行时（兜底档）。')

// 默认版本须与 engine-downloader.ts 的 engineVersion() 同源（full 内置 ⟺ thin 运行时下载同版本，缓存键才对得上）。
// engineDownloader.test.ts 有 SSOT 守卫：改这里也要改那里，否则 CI 红。
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

// ── claude（#1198）──────────────────────────────────────────────────────────────────────────────
// codex-acp 的 wrapper 无 JS 依赖（只 spawn 同级原生 bin），故 npm pack 即可。claude 不同：
// @agentclientprotocol/claude-agent-acp 有真 JS 依赖（@anthropic-ai/claude-agent-sdk 0.3.x + 其平台
// 原生 claude bin optional-dep + zod 等），必须解析依赖树 → 用 `npm install` 而非 npm pack。装进独立
// stage 再把整棵 node_modules **合并**进 acp-bundle/node_modules（不动上面 codex 的 @zed-industries）。
// 运行期命中 bundled adapter → 用 node 跑 dist/index.js；claude-agent-acp 的
// claudeCliPath() 优先读 CLAUDE_CODE_EXECUTABLE（曾由 engine-launch 指向下方 bundled claude bin;
// 那个启动器已随咕咕自建 ACP runtime 一起退役,今天由会话页插件自己 spawn 时决定），
// 否则经 sdk 的 platform optional-dep 自解析（缺则 #1189 preflight/fail-loud）。
const CLAUDE_PKG = '@agentclientprotocol/claude-agent-acp'
// 桥接是咕咕维护的构建 @gugu-acp/claude-agent-acp(#6394),按别名装回原包名;默认版本就是根 package.json
// 里那一份依赖(同一个事实只写一处),GUGU_CLAUDE_ACP_VERSION 只换版本号。
const rootClaudeSpec = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dependencies?.[CLAUDE_PKG]
const rootClaudeMatch = /^npm:(@gugu-acp\/claude-agent-acp)@(.+)$/.exec(rootClaudeSpec ?? '')
if (!rootClaudeMatch) {
  console.error(`[fetch-acp] FAIL: 根 package.json 的 ${CLAUDE_PKG} 不是 npm:@gugu-acp/claude-agent-acp@<版本>：${rootClaudeSpec}`)
  process.exit(1)
}
const CLAUDE_VERSION = process.env.GUGU_CLAUDE_ACP_VERSION || rootClaudeMatch[2]
const CLAUDE_SPEC = `${CLAUDE_PKG}@npm:${rootClaudeMatch[1]}@${CLAUDE_VERSION}`
console.log(`[fetch-acp] ${CLAUDE_SPEC}（+ claude-agent-sdk 平台原生 bin）for ${platform}-${arch}`)
const claudeStage = join(REPO_ROOT, 'acp-bundle', '.claude-stage')
rmSync(claudeStage, { recursive: true, force: true })
mkdirSync(claudeStage, { recursive: true })
// 独立 stage 安装全树（默认含 optional 的平台 claude 原生 bin）；--no-save/--no-package-lock 不写工程文件。
execFileSync(
  'npm',
  ['install', '--prefix', claudeStage, '--no-save', '--no-package-lock', CLAUDE_SPEC],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' },
)
// 合并 stage/node_modules/* → acp-bundle/node_modules/*（@zed-industries codex 已在、不被覆盖）。
const BUNDLE_NM = join(REPO_ROOT, 'acp-bundle', 'node_modules')
const stageNm = join(claudeStage, 'node_modules')
for (const entry of readdirSync(stageNm)) {
  cpSync(join(stageNm, entry), join(BUNDLE_NM, entry), { recursive: true, force: true })
}
rmSync(claudeStage, { recursive: true, force: true })
// 校验 adapter 入口（契约：engine-downloader 的 RESOURCES_ADAPTER_ENTRY_BY_PACKAGE 指此）。
const claudeEntry = join(BUNDLE_NM, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
if (!existsSync(claudeEntry)) {
  console.error(`[fetch-acp] FAIL: claude adapter 入口缺失：${claudeEntry}`)
  process.exit(1)
}
// 平台原生 claude bin（sdk 的 optional-dep）；npm pack 同病——install 落地后仍补可执行位。
const SDK_BIN_PKG = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
const claudeBinName = platform === 'win32' ? 'claude.exe' : 'claude'
const claudeBin = join(BUNDLE_NM, SDK_BIN_PKG, claudeBinName)
if (existsSync(claudeBin)) {
  if (platform !== 'win32') chmodSync(claudeBin, 0o755)
  console.log(`[fetch-acp] claude bin ok：${claudeBin}`)
} else {
  // 非致命：打包仍可用（CLAUDE_CODE_EXECUTABLE 留空 → sdk 自解析/系统 claude；缺则 #1189 fail-loud）。
  console.warn(`[fetch-acp] WARN: claude 平台原生 bin 未随 install 落地（${claudeBin}）；自包含将依赖外部 claude。`)
}
console.log(`[fetch-acp] ok（claude）：${BUNDLE_NM} 下 ${readdirSync(BUNDLE_NM).join(', ')}`)
