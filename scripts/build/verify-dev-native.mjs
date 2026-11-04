import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isElectronUnlaunchable } from '../ci/electron-launch-failure.mjs'
import { assertPtySymbolOutput, readPtyGlobalSymbols } from './native-addon-symbols.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// @@@dev-native-anchor — 首选产物锚点(生产 main.js 就是从那里解析原生模块的),
// **但缺了不能跳过**:`dist-electron/main.js` 是构建产物,fresh clone 上还不存在 ——
// 而那恰恰是 ABI 最可能错的时刻(`pnpm install` 刚按**你机器上的 node** 编完这些
// 原生模块,而 Electron 内置的是另一个 node)。缺锚点就退回仓库根,照查不误。
const builtAnchor = join(root, 'apps', 'desktop', 'dist-electron', 'main.js')
const anchor = existsSync(builtAnchor) ? builtAnchor : join(root, 'package.json')
const req = createRequire(anchor)

// symbol interposition(靠 nm 读 Mach-O)与 `posix_spawnp failed`(Darwin 的错误文案)
// 这两条断言都**只在 macOS 成立**,其他平台照抄必红 —— 本分支在 d15 实测过。
// 但 ABI 对不上是**跨平台**的坑,而且正是这道闸要防的那一个:从前整个脚本在非 darwin 上
// 直接 exit 0,等于把它一起放过了。所以分两档 —— macOS 全套,其余只跑纯 ABI 加载。
const isDarwin = process.platform === 'darwin'
if (isDarwin) {
  const ptyEntry = req.resolve('node-pty')
  const ptyNative = join(dirname(dirname(ptyEntry)), 'build', 'Release', 'pty.node')
  assertPtySymbolOutput(readPtyGlobalSymbols(ptyNative), `dev-tree-${process.arch}`)
} else {
  console.log(
    `[verify-dev-native] ${process.platform}: symbol isolation 与 pty 错误边界是 macOS 特有断言,跳过;ABI 加载照查`,
  )
}

// @@@conpty-payload-gate — Windows 的 pty 走 node-pty 自带的 ConPTY(`useConptyDll`),
// 而 `conpty.node` 按自己旁边的 `conpty\conpty.dll` 加载它。`electron-rebuild` 会重建
// 整个 `build/Release` 且不带这一层 ⇒ 缺了,产品上每条会话都死在 `Failed to load conpty.dll`。
// rebuild-native 负责补,这里负责判:缺了就当场红,❌ 别等到真机上才发现。
if (process.platform === 'win32') {
  const ptyRoot = dirname(dirname(req.resolve('node-pty')))
  const dll = join(ptyRoot, 'build', 'Release', 'conpty', 'conpty.dll')
  if (!existsSync(dll)) {
    console.error(`[verify-dev-native] node-pty 缺少随包 ConPTY:${dll}`)
    process.exit(1)
  }
  console.log('[verify-dev-native] OK node-pty bundled ConPTY present')
}

const electronBin = req('electron')
const electronVersion = JSON.parse(
  readFileSync(join(dirname(req.resolve('electron')), 'package.json'), 'utf8'),
).version
const probe = join(root, 'scripts', 'build', 'verify-dev-native-probe.cjs')
const STEP_PREFIX = '[verify-dev-native] step='

// @@@probe-no-deadline (#4357) — 等的是探针进程**退出**这个事实,不设墙钟上限。
//
// 从前这里是 `execFileSync(..., { timeout: 120_000 })`,探针里再套一层 5s 的 PTY 预算。
// 两层都在给同一件不由我们决定的事计时:CI 每个 job 全新 install + rebuild:native,于是 Electron
// 二进制与 spawn-helper / *.node 对 macOS 都是「新建的可执行文件」,首次执行要排一道**全机串行**
// 的安全检查。2026-09-22 在 mac1(负载 22–65)实测:同一次 rebuild 产出的 spawn-helper,新 inode
// 首次 PTY spawn 到退出 2.8s–108s,同一 inode 再跑一次 19–42ms。预算与被测量同阶 ⇒ 按负载随机判红,
// 而真正的失败(ABI 不一致、spawn-helper 缺失)都是**立刻抛错**,根本用不到计时。
//
// 所以:真挂住的唯一上限是最外层 —— CI job 的 timeout-minutes(本地就是人按 Ctrl-C)。
// 为了让那一刻看得出卡在哪,探针每一步开始时报一行 `step=`,这里把这些行**实时**转出去;
// 其余 stderr 仍然先收着,失败时再按下面的分类说人话(不接管的话,人先看到的是十几行 Electron 栈)。
function runProbe() {
  process.stderr.write(`${STEP_PREFIX}launch-electron (${electronBin})\n`)
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(electronBin, [probe, anchor], {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(isDarwin ? {} : { GUGU_NATIVE_PROBE_ABI_ONLY: '1' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let partial = ''
    let lastStep = 'launch-electron'
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      partial += chunk
      const lines = partial.split('\n')
      partial = lines.pop()
      for (const line of lines) {
        if (!line.startsWith(STEP_PREFIX)) continue
        lastStep = line.slice(STEP_PREFIX.length)
        process.stderr.write(`${line}\n`)
      }
    })
    child.on('error', rejectRun)
    child.on('close', (status, signal) => resolveRun({ status, signal, stdout, stderr, lastStep }))
  })
}

const run = await runProbe()
if (run.status !== 0) {
  // 这是**最常踩的那一种**失败,值得把话说完:原生模块按哪个 node 编的,和 Electron 内置的
  // 是不是同一个 ABI。不这么报的话,人看到的是会话页空白 + 日志深处一句 NODE_MODULE_VERSION,
  // 会去查会话页,而不是去重编模块。
  const detail = `${run.stderr}${run.stdout}`
  // @@@electron-unlaunchable — Electron 二进制**自己**起不来,不是原生模块的事。
  //
  // 2026-08-18 v0.2.33 的 linux-appimage 被这条打断:构建镜像是精简的,没有 libnss3.so,
  // 动态链接器在 Electron 主二进制上就失败了(exit 127),而 `build:app` 会调 `rebuild:native`,
  // 后者末尾正是本脚本 —— 于是整条 Linux CD 红。这是本闸从「非 darwin 直接 exit 0」改成
  // 「非 darwin 也跑 ABI 加载」时带进来的:d15 上有完整 Electron 运行库,构建容器没有,
  // 我按 d15 的读数以为 Linux 这条路通了。
  //
  // ❌ 这不是「兜底」:两种失败在信号上可精确区分,不会互相冒充 ——
  //   ABI 不一致 → Electron **起得来**,在 require 时报 NODE_MODULE_VERSION;
  //   缺共享库   → Electron **根本没起来**,exit 127 + 动态链接器的 loading shared libraries。
  // 而且放过它不会漏掉真问题:一台连 Electron 都跑不起来的机器,`pnpm dev` 同样起不来,
  // 会在别处 fail loud;构建容器里原生模块由 electron-builder 自己 --build-from-source 重编,
  // 本闸要防的「pnpm install 按宿主 node 编完就直接用」那个前提在那里根本不成立。
  if (isElectronUnlaunchable(run.status, detail)) {
    console.log(
      `[verify-dev-native] ${process.platform}: Electron 二进制无法启动(缺共享库),跳过 ABI 探测。\n`
      + '  这类环境(精简构建镜像/无 GUI 依赖的容器)里 Electron 本就跑不起来,本闸没有判据可言;\n'
      + `  原始报错:${detail.trim().split('\n')[0]}`,
    )
    process.exit(0)
  }
  if (detail.includes('NODE_MODULE_VERSION')) {
    console.error(
      '\n[verify-dev-native] 原生模块的 ABI 与 Electron 对不上 —— '
      + `它们是按你机器上的 Node(${process.versions.modules})编的,而 Electron ${electronVersion} 要的是另一个。\n`
      + '这不是代码问题,是每次 `pnpm install` 重装 better-sqlite3 / node-pty 之后的必然状态。\n\n'
      + '    修:pnpm rebuild:native\n\n'
      + `原始报错:\n${detail.trim().split('\n').slice(0, 6).join('\n')}\n`,
    )
    process.exit(1)
  }
  throw new Error(
    `[verify-dev-native] runtime probe failed at step=${run.lastStep} `
    + `(exit=${run.status ?? 'null'} signal=${run.signal ?? 'none'}):\n${detail.trim()}`,
  )
}
const output = run.stdout
const reading = JSON.parse(output.trim())

if (reading.electron !== electronVersion) {
  throw new Error(
    `[verify-dev-native] Electron ${reading.electron} does not match installed ${electronVersion}`,
  )
}
if (reading.arch !== process.arch || reading.sqlite !== true) {
  throw new Error(`[verify-dev-native] invalid runtime probe reading: ${output.trim()}`)
}
if (isDarwin) {
  if (reading.normalPty !== true) {
    throw new Error(`[verify-dev-native] invalid runtime probe reading: ${output.trim()}`)
  }
  if (!String(reading.nativeError).includes('posix_spawnp failed')) {
    throw new Error('[verify-dev-native] runtime probe did not observe posix_spawnp failed')
  }
} else if (reading.abiOnly !== true) {
  // 非 macOS 必须真的走了 abi-only 那一档。少了这一条,探针哪天忘了认那个开关,
  // 这里会拿着一份**全套模式**的读数当成通过 —— 而全套模式在这个平台上本该是红的。
  throw new Error(`[verify-dev-native] expected an ABI-only probe reading: ${output.trim()}`)
}

console.log(
  `[verify-dev-native] OK electron=${reading.electron} arch=${reading.arch} `
  + (isDarwin ? 'symbols=isolated native-error=caught normal-pty=passed ' : 'mode=abi-only ')
  + 'sqlite=loaded',
)
