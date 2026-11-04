// @@@verify-packaged-natives (#2282) - 打包产物级 per-arch native 校验:证明 npmRebuild:false +
// beforePack 逐架构 electron-rebuild 没有「绕过编译」。对每个要求的架构,用**该架构打包出的
// Electron 二进制自己**(ELECTRON_RUN_AS_NODE=1 → electron 内嵌 node,ABI 149)require
// app/node_modules 里的 better-sqlite3 / node-pty 并真实例化 sqlite,断言 process.arch === 期望架构
// 且 process.versions.electron === 根 package.json 的 electron pin。arm64 宿主上验 x64 产物必须
// 显式经 Rosetta(`arch -x86_64`),Rosetta 不可用即 fail-loud——x64 产物没验过就不得发布
// (workflow 里 publish 步在本脚本之后,两架构全过才发)。
// 用法: node scripts/verify-packaged-natives.mjs <releaseDir> <arch,arch>   例: release x64,arm64
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
// @@@2299 单一来源:bridge 的 external 清单——app 锚点 probe 逐个真 require,新增 external
// 自动纳入生产路径探测。
import { EMDASH_EXTERNAL } from '../apps/desktop/electron/sessionpage/sessionpage-main-build.mjs'
import {
  assertPtySymbolOutput,
  readPtyGlobalSymbols,
} from './build/native-addon-symbols.mjs'

const [releaseDir, archListRaw] = process.argv.slice(2)
if (!releaseDir || !archListRaw) {
  throw new Error('[verify-packaged-natives] 用法: node scripts/verify-packaged-natives.mjs <releaseDir> <arch,arch>')
}
const archs = archListRaw.split(',').map((s) => s.trim()).filter(Boolean)
const APP_SUBDIR = { x64: 'mac', arm64: 'mac-arm64' }
const ARCH_CMD_FLAG = { x64: '-x86_64', arm64: '-arm64' }

// 期望值 = 本仓已安装的 electron **解析版**(node_modules,lockfile 的事实来源;devDeps 的 ^range 不是
// pin——electron-rebuild 与 electron-builder 打包用的都是这个解析版,断言必须对同一事实源)。
const require_ = createRequire(import.meta.url)
const electronPin = JSON.parse(
  readFileSync(join(dirname(require_.resolve('electron')), 'package.json'), 'utf8'),
).version

function assertPtySymbolIsolation(appModulesDir, arch) {
  const ptyNative = join(appModulesDir, 'node-pty', 'build', 'Release', 'pty.node')
  assertPtySymbolOutput(readPtyGlobalSymbols(ptyNative), arch)
}

const probeDir = mkdtempSync(join(tmpdir(), 'gugu-native-probe-'))
const probe = join(probeDir, 'probe.cjs')
// 单锚点验证(@@@kill-asar):asar 已关,整包落地为 Contents/Resources/app/ 一棵真实目录树,不再有
// app.asar(虚拟)/ app.asar.unpacked(真实)双世界。锚点 = 主进程产物的真实路径(app/…/dist-electron/main.js;
// @@@4865 会话页主进程图已是同一次 rollup 的 chunk,与 main.js 同目录),createRequire 从这里解析走的正是
// 生产主进程 require 原生 addon 的同一条真实父目录链 → 测试路径 = 生产路径。
// #2299 那类「模块拆在 asar 内外两侧、require 链炸穿」在单一真实 fs 上结构性不存在,故原双锚点收敛为一。
writeFileSync(
  probe,
  `
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const resourcesDir = process.argv[2]
const expectedElectron = process.argv[3]
const expectedArch = process.argv[4]
const bridgeExternals = process.argv[5].split(',').filter(Boolean)
// @@@probe-steps (#4357) — 同 scripts/build/verify-dev-native-probe.cjs:每步开始前往 stderr 报一行,
// 不设墙钟预算;真挂住由最外层(job 的 timeout-minutes)收场,日志最后一行 step= 就是卡住的位置。
let currentStep = 'start'
function step(label, name) {
  currentStep = label + ' ' + name
  process.stderr.write('[verify-packaged-natives] step=' + currentStep + '\\n')
}
function probeNativePtyErrorBoundary(label, req) {
  const ptyEntry = req.resolve('node-pty')
  const ptyRoot = path.dirname(path.dirname(ptyEntry))
  const binding = req(path.join(ptyRoot, 'build', 'Release', 'pty.node'))
  let caught
  try {
    binding.fork(
      '/bin/sh',
      ['-c', 'exit 0'],
      ['HOME=' + os.homedir(), 'PATH=' + (process.env.PATH || '')],
      os.tmpdir(),
      80,
      24,
      -1,
      -1,
      true,
      path.join(os.tmpdir(), 'gugu-missing-node-pty-spawn-helper'),
      () => {},
    )
  } catch (error) {
    caught = error
  }
  if (!caught || !String(caught.message || caught).includes('posix_spawnp failed')) {
    throw new Error(label + ': node-pty native error 未回到 JavaScript boundary')
  }
}
function probeNormalPtySpawn(label, pty) {
  return new Promise((resolve, reject) => {
    const child = pty.spawn('/bin/sh', ['-c', 'printf GUGU_PTY_OK'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: { HOME: os.homedir(), PATH: process.env.PATH || '', TERM: 'xterm-256color' },
    })
    let output = ''
    child.onData((data) => { output += data })
    child.onExit(({ exitCode }) => {
      if (exitCode !== 0 || !output.includes('GUGU_PTY_OK')) {
        reject(new Error(label + ': normal PTY spawn failed exit=' + exitCode))
        return
      }
      resolve()
    })
  })
}
// 深探已知三 native(实例化/真 native 调用,typeof 不加载 binding);其余 external 逐个真 require。
// electron = 运行时内建、cpu-features = optional(ssh2 try/catch 缺席即降级)→ 跳过。
async function probeAnchor(label, req) {
  step(label, 'load-better-sqlite3')
  const Database = req('better-sqlite3')
  const db = new Database(':memory:')
  db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (42)')
  if (db.prepare('SELECT x FROM t').get().x !== 42) throw new Error(label + ': sqlite native 实测失败')
  db.close()
  // subscribe 同时验证 @parcel/watcher 的 JS 运行时闭包(picomatch/is-glob/detect-libc)与
  // platform optional 包(@parcel/watcher-darwin-*)在**该锚点的解析链**上真实可达。watcher 必须先
  // 于 node-pty 加载,复现生产主进程的 native-addon 顺序并锁住跨-addon symbol interposition 回归。
  step(label, 'load-watcher')
  const watcher = req('@parcel/watcher')
  // @@@probe-watch-scope — 同 scripts/build/verify-dev-native-probe.cjs:订阅当场新建的空目录。
  // subscribe 恒为递归,拿 os.tmpdir() 当根会把「验 addon 能不能加载」变成「扫整个系统临时目录」,
  // 在 16 槽共享该目录的 CI 机上开销不设上限,是假红来源。空目录不减证明力,代价是常数。
  const watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-packaged-probe-'))
  try {
    const sub = await watcher.subscribe(watchRoot, () => {})
    await sub.unsubscribe()
  } finally {
    fs.rmSync(watchRoot, { recursive: true, force: true })
  }
  step(label, 'load-node-pty')
  const pty = req('node-pty')
  if (typeof pty.spawn !== 'function') throw new Error(label + ': node-pty native 加载后无 spawn')
  step(label, 'pty-native-error-boundary')
  probeNativePtyErrorBoundary(label, req)
  step(label, 'normal-pty-spawn (waiting for the child to exit)')
  await probeNormalPtySpawn(label, pty)
  step(label, 'require-bridge-externals')
  for (const m of bridgeExternals) {
    if (['electron', 'cpu-features', 'better-sqlite3', 'node-pty', '@parcel/watcher'].includes(m)) continue
    req(m)
  }
  // @@@renderer-deps-are-dev (#4917) — 主进程里按**字符串**在运行时找、任何按 import 图摇树的工具都
  // 看不见的三条路径。它们只靠「在根 dependencies 里」进包,漏了 = 起 agent 会话 / 装引擎当场失败,
  // 而构建照样绿。这里在产物的真实解析链上逐条核,判据与生产代码同形:
  //  · claude 的 ACP 适配器入口 —— packages/session-plugins/src/agents/impl/claude/index.ts 用
  //    _require.resolve(同一 spec 字符串)找,这里也 resolve,并断言落在包内(realpath 两边取齐,
  //    macOS /tmp → /private/tmp 这类 symlink 不能算「包外」)。codex 的 ACP 腿只走咕咕自建的
  //    dist-electron/runtime/codex-app-server-acp.mjs,不再依赖第三方适配器包(#6394);
  //  · npm CLI —— engine-downloader.ts 是**路径拼接** node_modules/npm/bin/npm-cli.js 再 existsSync,
  //    ❌ 不是 resolve:npm 的 exports 表只导出 '.' 与 './package.json',resolve 子路径必抛
  //    ERR_PACKAGE_PATH_NOT_EXPORTED(beta run 34936630165 实撞),所以这里同样只查文件在不在。
  const resourcesReal = fs.realpathSync(resourcesDir)
  for (const spec of [
    '@agentclientprotocol/claude-agent-acp/dist/index.js',
    // #7191 浏览器工具:browser-agent-mcp.ts 运行时 require('@playwright/mcp'),再从它的位置 require('playwright-core')。
    '@playwright/mcp',
  ]) {
    let resolved
    try {
      resolved = fs.realpathSync(req.resolve(spec))
    } catch (error) {
      throw new Error(label + ': ' + spec + ' 在产物解析链上找不到(' + (error && error.code || error) + ')—— 主进程 require.resolve 同一字符串,起 agent 会话会当场失败')
    }
    if (!resolved.startsWith(resourcesReal + path.sep)) {
      throw new Error(label + ': ' + spec + ' 解析到包外 ' + resolved + '(产物自身缺这份,靠外部环境兜住了)')
    }
  }
  // 连浏览器的 playwright-core 必须从 @playwright/mcp 的位置解析得到(与出工具的是同一份),且在包内。
  {
    const fromMcp = createRequire(req.resolve('@playwright/mcp'))
    let core
    try {
      core = fs.realpathSync(fromMcp.resolve('playwright-core'))
    } catch (error) {
      throw new Error(label + ': 从 @playwright/mcp 解析不到 playwright-core(' + (error && error.code || error) + ')—— 会话里的浏览器工具一调就失败')
    }
    if (!core.startsWith(resourcesReal + path.sep)) {
      throw new Error(label + ': playwright-core 解析到包外 ' + core)
    }
  }
  const npmCli = path.join(resourcesReal, 'app', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(npmCli)) {
    throw new Error(label + ': 缺 ' + npmCli + ' —— engine-downloader 用它装引擎(npm 必须留在根 dependencies)')
  }
}
async function main() {
  if (!process.versions.electron) throw new Error('probe 不在 electron 运行时里(ELECTRON_RUN_AS_NODE 失效?)')
  if (process.versions.electron !== expectedElectron)
    throw new Error('electron ' + process.versions.electron + ' ≠ 安装解析版 ' + expectedElectron)
  if (process.arch !== expectedArch)
    throw new Error('process.arch ' + process.arch + ' ≠ 期望 ' + expectedArch)
  const distElectron = path.join(resourcesDir, 'app', 'apps', 'desktop', 'dist-electron')
  const mainPath = path.join(distElectron, 'main.js')
  fs.accessSync(mainPath) // 主进程本体在真实 app/ 目录
  // 任务页主进程 chunk、三个 fork worker 与用量页的 token 扫描线程(#6334)必须与 main.js 同目录真实存在
  // (worker 按本 chunk 同目录解析,见 worker-manifest.ts)
  for (const sibling of ['emdash-main-bridge.js', 'acp-runtime.js', 'agent-config-runtime.js', 'fs-watch-runtime.js', 'usage-token-scan.js']) {
    fs.accessSync(path.join(distElectron, sibling))
  }
  await probeAnchor('app-anchor', createRequire(mainPath))
  console.log('[probe] OK electron=' + process.versions.electron + ' arch=' + process.arch + ' abi=' + process.versions.modules + ' anchor=app')
}
main().catch((err) => { console.error('[verify-packaged-natives] failed at step=' + currentStep); console.error(err); process.exit(1) })
`,
)

try {
  for (const arch of archs) {
    const sub = APP_SUBDIR[arch]
    if (!sub) throw new Error(`[verify-packaged-natives] 未知 arch: ${arch}`)
    // 绝对路径:probe 在 electron 进程里 require,相对路径会被当 bare specifier。
    const dir = resolve(releaseDir, sub)
    const appName = existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith('.app')) : null
    if (!appName) throw new Error(`[verify-packaged-natives] ${dir} 下找不到 .app(${arch} 产物缺失)`)
    const appPath = join(dir, appName)
    const macosDir = join(appPath, 'Contents/MacOS')
    const bin = join(macosDir, readdirSync(macosDir)[0])
    const resourcesDir = join(appPath, 'Contents/Resources')
    const appModulesDir = join(resourcesDir, 'app/node_modules')
    for (const m of ['better-sqlite3', 'node-pty']) {
      if (!existsSync(join(appModulesDir, m))) {
        throw new Error(`[verify-packaged-natives] ${arch}: app/node_modules 缺 ${m}`)
      }
    }
    assertPtySymbolIsolation(appModulesDir, arch)
    let cmd = bin
    let args = [probe, resourcesDir, electronPin, arch, EMDASH_EXTERNAL.join(',')]
    if (arch !== process.arch) {
      // 跨架构执行:先 fail-loud 验证翻译层(arm64 宿主验 x64 = Rosetta)可用,再显式 arch 前缀运行。
      try {
        execFileSync('arch', [ARCH_CMD_FLAG[arch], '/usr/bin/true'])
      } catch {
        throw new Error(
          `[verify-packaged-natives] 宿主(${process.arch})无法执行 ${arch} 二进制(Rosetta/翻译层不可用)——` +
            `${arch} 产物无法验证,不得发布;先在构建机安装 Rosetta(softwareupdate --install-rosetta)。`,
        )
      }
      cmd = 'arch'
      args = [ARCH_CMD_FLAG[arch], bin, ...args]
    }
    // 等的是探针退出这个事实,不设墙钟上限(#4357):打包产物里的 Electron 与 spawn-helper 都是新 inode,
    // 首次执行排 macOS 全机串行的安全检查,耗时不由我们决定。stderr 直通(inherit),探针的 step= 行
    // 实时进日志 —— 挂住时由 job 的 timeout-minutes 收场,最后一行 step= 就是卡住的位置。
    // ❌ 别换回 execFileSync:它把 stderr 攒到子进程退出才吐,挂住时日志里一行 step= 都没有。
    const run = spawnSync(cmd, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 16 * 1024 * 1024,
    })
    if (run.error) throw run.error
    if (run.status !== 0) {
      throw new Error(
        `[verify-packaged-natives] ${arch} probe failed (exit=${run.status ?? 'null'} signal=${run.signal ?? 'none'}); `
          + `the step= and error lines above say where.\n${run.stdout ?? ''}`,
      )
    }
    const out = run.stdout
    process.stdout.write(out)
    console.log(`[verify-packaged-natives] ${arch} OK — ${appPath}`)
  }
  console.log(`[verify-packaged-natives] 全部架构通过: ${archs.join(', ')}`)
} finally {
  rmSync(probeDir, { recursive: true, force: true })
}
