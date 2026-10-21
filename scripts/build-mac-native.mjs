#!/usr/bin/env node
// #7199 咕咕在 Mac 上要带的两个原生程序,放进 mac-native/<arch>/(打包时 electron-builder 拷进 Resources/mac-native):
//   1. gugu-mac-helper —— 咕咕自己的原生助手(apps/desktop/native/mac-helper,从源码编):日历 / 提醒事项 / 通讯录 / 定位 / 文字识别 / 系统授权;
//   2. cua-driver —— 「电脑控制」(trycua/cua,MIT),下载钉住的维护修订(scripts/cua-driver-release.mjs),
//      从 universal 二进制里抽出这个架构那一片;同时导出它的工具清单(cua-tools.json,咕咕登记动作时读它)与两份许可证。
//
// 用法:node scripts/build-mac-native.mjs [--arch arm64|x64]   —— mac-native/<arch>/ 每次整个重建(旧产物不留)。
// 本地开发要用「这台电脑能做的事」里的日历、电脑控制等,先跑一次这个(在 owner 的 MBP 上请套 nice -n 15 lockf -k /tmp/gugu-heavy.lock)。
// 只在 macOS 上能编;别的平台直接报错退出(❌ 静默跳过 —— 打 Mac 包时缺了它,用户点「连接」才发现)。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyCuaLicenses, CUA_DRIVER_VERSION, exportCuaTools, extractOne, obtainCuaDriverArchive } from './cua-driver-release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

if (process.platform !== 'darwin') {
  console.error('[build-mac-native] 只能在 macOS 上编(要 Xcode 的 swift 工具链与 lipo)')
  process.exit(1)
}

const arch = arg('--arch', process.arch === 'arm64' ? 'arm64' : 'x64')
if (arch !== 'arm64' && arch !== 'x64') {
  console.error(`[build-mac-native] --arch 只认 arm64 / x64,收到 ${arch}`)
  process.exit(1)
}
const machArch = arch === 'x64' ? 'x86_64' : 'arm64'
const out = path.join(root, 'mac-native', arch)
const cache = path.join(root, '.build', 'mac-native-cache')

function run(cmd, args, options = {}) {
  console.log(`[build-mac-native] $ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { stdio: 'inherit', ...options })
}

function swiftBuild(packagePath, scratch) {
  run('swift', ['build', '-c', 'release', '--arch', machArch, '--package-path', packagePath, '--scratch-path', scratch])
  return execFileSync('swift', ['build', '-c', 'release', '--arch', machArch, '--package-path', packagePath, '--scratch-path', scratch, '--show-bin-path'], { encoding: 'utf8' }).trim()
}

const archsOf = (file) => execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }).trim().split(/\s+/)

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(cache, { recursive: true })

// 1. 咕咕的原生助手
const helperBin = swiftBuild(path.join(root, 'apps/desktop/native/mac-helper'), path.join(cache, `helper-${arch}`))
fs.copyFileSync(path.join(helperBin, 'gugu-mac-helper'), path.join(out, 'gugu-mac-helper'))
fs.chmodSync(path.join(out, 'gugu-mac-helper'), 0o755)
if (!archsOf(path.join(out, 'gugu-mac-helper')).includes(machArch)) throw new Error(`[build-mac-native] gugu-mac-helper 不是 ${machArch}`)

// 2. cua-driver:包里只要 cua-driver 本身(它不链那个 dylib);签名由 electron-builder 打包时用咕咕的身份重签。
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cua-driver-'))
try {
  const universal = extractOne(obtainCuaDriverArchive('darwin-universal'), 'cua-driver', staging)
  const fat = archsOf(universal)
  if (!fat.includes('arm64') || !fat.includes('x86_64')) throw new Error(`[build-mac-native] 发布包里的 cua-driver 是 ${fat.join(',')},不是 universal`)
  const target = path.join(out, 'cua-driver')
  run('lipo', [universal, '-thin', machArch, '-output', target])
  fs.chmodSync(target, 0o755)
  const thin = archsOf(target)
  if (thin.join(',') !== machArch) throw new Error(`[build-mac-native] 抽出来的 cua-driver 是 ${thin.join(',')},不是只有 ${machArch}`)
  // 工具清单用 universal 原包导出(本机架构一定能跑;两种架构的工具相同),❌ 靠 Rosetta 跑 x64 那片。
  fs.writeFileSync(path.join(out, 'cua-tools.json'), exportCuaTools(universal))
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}
copyCuaLicenses(out)

const toolCount = JSON.parse(fs.readFileSync(path.join(out, 'cua-tools.json'), 'utf8')).tools.length
console.log(`[build-mac-native] ✓ ${out}: gugu-mac-helper, cua-driver ${CUA_DRIVER_VERSION} (${machArch}, ${toolCount} tools)`)
