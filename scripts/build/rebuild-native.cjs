const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createNativeAddonBuildEnv } = require('./native-addon-build-policy.cjs')

const NATIVE_MODULES = 'better-sqlite3,node-pty'

/**
 * @@@conpty-payload — node-pty 的 Windows 传输要用**它自己带的那份 ConPTY**
 * (`useConptyDll`,理由见 packages/session-core/src/pty/node/conpty.ts),而
 * `conpty.node` 是按**自己旁边**的 `conpty\conpty.dll` 去加载它的。
 *
 * npm/pnpm 装出来的包里 `build/Release/conpty/` 本来是有的,但 `electron-rebuild
 * --build-from-source` 会把整个 `build/Release` 重新生成 —— 只产出 `.node`,
 * 不带这一层。重建之后如果不补回来,Windows 上每一条 pty 都会死在
 * `Failed to load conpty.dll`,而那时人在看的是「会话页起不来会话」。
 */
function restoreWindowsConptyPayload({
  platform = process.platform,
  arch = process.arch,
  root = process.cwd(),
} = {}) {
  if (platform !== 'win32') return null
  const ptyRoot = path.dirname(path.dirname(require.resolve('node-pty', { paths: [root] })))
  const from = path.join(ptyRoot, 'prebuilds', `win32-${arch}`, 'conpty')
  const to = path.join(ptyRoot, 'build', 'Release', 'conpty')
  if (!fs.existsSync(path.join(from, 'conpty.dll'))) {
    throw new Error(`[rebuild-native] node-pty 没有随包的 ConPTY:${from}/conpty.dll 不存在`)
  }
  fs.rmSync(to, { recursive: true, force: true })
  fs.cpSync(from, to, { recursive: true })
  console.log(`[rebuild-native] restored node-pty ConPTY payload -> ${to}`)
  return to
}

function runNativeRebuild({
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const command = 'electron-rebuild'
  // --build-from-source:同 electron-builder.cjs 的 native-abi-owner hook(run 29914453877 实证)——
  // @electron/rebuild 默认先走 prebuild 下载路径,墙内 runner 上会在几秒内静默用错架构/错 ABI 的
  // 预编译二进制冒充「Rebuild Complete」。#4401 这次的 CI 覆盖闸(linux-native-rebuild)整个存在
  // 意义就是逼一次真编译;不带这个 flag,一旦上游给 Electron 44 发布 prebuild,闸会退化成几秒的
  // 下载,不再实际验证 GCC 能不能编过 Electron 头,覆盖缺口原样复发。
  const args = ['-f', '--build-from-source', '--only', NATIVE_MODULES]
  const result = spawn(command, args, {
    cwd: process.cwd(),
    env: createNativeAddonBuildEnv(platform, env),
    shell: platform === 'win32',
    stdio: 'inherit',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`[rebuild-native] electron-rebuild exited with status ${result.status ?? 'unknown'}`)
  }

  restoreWindowsConptyPayload({ platform })
}

module.exports = {
  NATIVE_MODULES,
  restoreWindowsConptyPayload,
  runNativeRebuild,
}

if (require.main === module) {
  try {
    runNativeRebuild()
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
