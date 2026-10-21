#!/usr/bin/env node
// #7199 咕咕在 Windows 上要带的原生程序,放进 win-native/<arch>/(打包时 electron-builder 拷进 resources/win-native):
//   cua-driver.exe —— 「电脑控制」(github.com/trycua/cua,MIT),下载钉住的发布包(scripts/cua-driver-release.mjs)。
//   包里还有 cua-cursor-theme.exe(只给 `cua-driver cursor-theme` 编光标主题用)、cua-driver-uia.exe(保留、默认不启用的
//   uiAccess worker)、cua_driver_sdk.dll / .node / .h(嵌入用的 SDK);cua-driver.exe 只导入系统 DLL,这些都不带。
//   同时导出工具清单(cua-tools.json,咕咕登记动作时读它)与两份许可证。
//
// 用法:node scripts/build-win-native.mjs [--arch x64|arm64]   —— win-native/<arch>/ 每次整个重建(旧产物不留)。
// 工具清单只能由 cua-driver.exe 自己导出,所以必须在 Windows 上跑(CI 打 Windows 包的 runner 都是 Windows x64);
// 别的平台下载、校验、解压照做,到导出那步报错退出(❌ 静默跳过 —— 缺清单的包装上去「电脑控制」一个动作都没有)。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, copyCuaLicenses, CUA_DRIVER_VERSION, exportCuaTools, extractOne, obtainCuaDriverArchive } from './cua-driver-release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const arch = arg('--arch', process.arch === 'arm64' ? 'arm64' : 'x64')
if (arch !== 'x64' && arch !== 'arm64') {
  console.error(`[build-win-native] --arch 只认 x64 / arm64,收到 ${arch}`)
  process.exit(1)
}
const out = path.join(root, 'win-native', arch)

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const exe = extractOne(obtainCuaDriverArchive(`win32-${arch}`), 'cua-driver.exe', out)
assertPeMachine(exe, arch)
copyCuaLicenses(out)

if (process.platform !== 'win32') {
  throw new Error(
    `[build-win-native] cua-tools.json 只能在 Windows 上用 cua-driver.exe 导出,这里是 ${process.platform}。` +
      `${out} 里的 cua-driver.exe 已下载、校验、解压,但缺清单的目录不能进包 —— 去 Windows 上打包(pnpm build:win)。`,
  )
}
// 用这台机器能跑的那一份导出(x64 的 Windows 跑不了 arm64 的 exe;两种架构的工具相同)。
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
let tools
if (hostArch === arch) {
  tools = exportCuaTools(exe)
} else {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cua-driver-'))
  try {
    tools = exportCuaTools(extractOne(obtainCuaDriverArchive(`win32-${hostArch}`), 'cua-driver.exe', staging))
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}
fs.writeFileSync(path.join(out, 'cua-tools.json'), tools)

console.log(`[build-win-native] ✓ ${out}: cua-driver.exe ${CUA_DRIVER_VERSION} (${arch}, ${JSON.parse(tools).tools.length} tools)`)
