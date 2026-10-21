const { createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// @@@node-mode-only (#4357) — 本探针只能以 ELECTRON_RUN_AS_NODE=1 跑(verify-dev-native.mjs 就这么调)。
// 不带它时 Electron 按 GUI app 跑:任何未捕获异常都会弹一个「A JavaScript error occurred in the main
// process」的**模态框**,主线程停在 `-[NSAlert runModal]`,零输出、永不退出 —— mac1 上实测一个手工调用
// 的探针就这样挂了两个多小时。所以在做任何可能抛错的事之前先认模式,不对就写 stderr 并退出。
// ❌ 别改成 throw:在 GUI 模式下 throw 正是那个模态框。
if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
  process.stderr.write('[verify-dev-native] run this probe via `node scripts/verify-dev-native.mjs` (it needs ELECTRON_RUN_AS_NODE=1)\n')
  process.exit(2)
}

const [anchor] = process.argv.slice(2)
if (!anchor) throw new Error('[verify-dev-native] missing module-resolution anchor')

// createRequire 只收绝对路径;相对锚点按当前目录解析,而不是抛 ERR_INVALID_ARG_VALUE。
const req = createRequire(path.resolve(anchor))

// @@@probe-steps (#4357) — 每一步开始前往 stderr 报一行 `step=<名字>`。
// 这里**没有任何墙钟预算**:每一步等的都是事实(模块加载完、PTY 子进程退出)。
// mac1 上那一步的耗时不由我们决定 —— rebuild:native 刚产出的 spawn-helper 是新 inode,
// 它的首次 execve 要排 macOS 全机串行的安全检查,并发车道多时实测 2.8s–108s,同一 inode 第二次 20–42ms。
// 真挂住的唯一上限是最外层(CI job 的 timeout-minutes);那时日志里最后一行 step= 就是卡住的位置。
const STEP_PREFIX = '[verify-dev-native] step='
let currentStep = 'start'
function step(name) {
  currentStep = name
  process.stderr.write(`${STEP_PREFIX}${name}\n`)
}

function probeNativePtyErrorBoundary() {
  const ptyEntry = req.resolve('node-pty')
  const ptyRoot = path.dirname(path.dirname(ptyEntry))
  const binding = req(path.join(ptyRoot, 'build', 'Release', 'pty.node'))
  let caught

  try {
    binding.fork(
      '/bin/sh',
      ['-c', 'exit 0'],
      [`HOME=${os.homedir()}`, `PATH=${process.env.PATH || ''}`],
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

  const message = String(caught?.message || caught || '')
  if (!message.includes('posix_spawnp failed')) {
    throw new Error('[verify-dev-native] node-pty native error did not return to the JavaScript boundary')
  }
  return message
}

function probeNormalPtySpawn(pty) {
  return new Promise((resolve, reject) => {
    const child = pty.spawn('/bin/sh', ['-c', 'printf GUGU_PTY_OK'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.tmpdir(),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH || '',
        TERM: 'xterm-256color',
      },
    })
    let output = ''
    child.onData((data) => {
      output += data
    })
    child.onExit(({ exitCode }) => {
      if (exitCode !== 0 || !output.includes('GUGU_PTY_OK')) {
        reject(new Error(`[verify-dev-native] normal PTY spawn failed with exit ${exitCode}`))
        return
      }
      resolve()
    })
  })
}

// @@@abi-only — symbol interposition 与 `posix_spawnp failed` 那两条断言都是**macOS 特有**的
// (前者靠 nm 读 Mach-O,后者是 Darwin 的错误文案;Linux 上文案不同,照抄断言必红)。
// 但 ABI 不一致是**跨平台**的坑,而且正是本探针要防的那一个。所以非 macOS 跑这一档:
// 只把三个原生模块真加载一遍 —— 加载成功即 ABI 相符,加载失败即 NODE_MODULE_VERSION 报错。
// 判据一分不减,只是不去断言那些在这个平台上本来就不成立的东西。
async function abiOnly() {
  step('load-watcher')
  const watcher = req('@parcel/watcher')
  const watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-native-abi-'))
  try {
    const subscription = await watcher.subscribe(watchRoot, () => {})
    await subscription.unsubscribe()
  } finally {
    fs.rmSync(watchRoot, { recursive: true, force: true })
  }
  step('load-node-pty')
  req('node-pty')
  step('load-better-sqlite3')
  const Database = req('better-sqlite3')
  new Database(':memory:').close()
  console.log(JSON.stringify({
    electron: process.versions.electron,
    arch: process.arch,
    abiOnly: true,
    sqlite: true,
  }))
}

async function main() {
  if (!process.versions.electron) {
    throw new Error('[verify-dev-native] probe is not running in Electron')
  }
  if (process.env.GUGU_NATIVE_PROBE_ABI_ONLY === '1') {
    await abiOnly()
    return
  }

  // Production main loads watcher before node-pty; preserving the order makes symbol interposition observable.
  step('load-watcher')
  const watcher = req('@parcel/watcher')
  // @@@probe-watch-scope — 订阅**当场新建的空目录**,不是 os.tmpdir()。
  //
  // `@parcel/watcher.subscribe` 恒为递归(Options 里只有 ignore/backend,没有深度——产品侧
  // 正因如此才不用它,见 packages/session-core/src/services/fs-watch/impl/directory-watch.ts)。
  // 订阅 os.tmpdir() 于是要对整个系统临时目录建 FSEvents 流并做初始扫描,而 mac1 上 16 个
  // CI 槽同用户共享这一个目录 —— 开销随它当时堆了多少东西涨,与 CPU 闲忙无关。实测代价:
  // 探针在 15s spawn 兜底上超时,同一 commit 连红两次、第三次自己绿(2026-08-16)。
  //
  // 本探针要证的是「watcher 原生扩展能在该锚点加载,且不与 node-pty 发生 symbol interposition」,
  // 跟被订阅目录里有什么毫无关系。换成空目录,证明力一字不减,代价变成常数。
  const watchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-native-probe-'))
  try {
    const subscription = await watcher.subscribe(watchRoot, () => {})
    await subscription.unsubscribe()
  } finally {
    fs.rmSync(watchRoot, { recursive: true, force: true })
  }

  step('load-node-pty')
  const pty = req('node-pty')
  step('pty-native-error-boundary')
  const nativeError = probeNativePtyErrorBoundary()
  step('normal-pty-spawn (waiting for the child to exit)')
  await probeNormalPtySpawn(pty)

  // @@@probe-sqlite — better-sqlite3 也要**在这里**真加载一次。
  // 它和 node-pty 由同一条 `pnpm rebuild:native` 一起重编,所以 ABI 错时两个一起错、
  // 查 node-pty 也能间接照出来 —— 但间接的判据会随构建方式的改动悄悄失效,而这一个
  // 正是会话页后端唯一依赖的原生模块:它坏了的表现是**会话页空白**,
  // 而 app 本身照常启动,错误只落在日志深处。直接查它,别指望连坐。
  step('load-better-sqlite3')
  const Database = req('better-sqlite3')
  const db = new Database(':memory:')
  db.close()

  console.log(JSON.stringify({
    electron: process.versions.electron,
    arch: process.arch,
    nativeError,
    normalPty: true,
    sqlite: true,
  }))
}

main().catch((error) => {
  console.error(`[verify-dev-native] failed at step=${currentStep}`)
  console.error(error)
  process.exitCode = 1
})
