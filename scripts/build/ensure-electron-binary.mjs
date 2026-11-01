#!/usr/bin/env node
// @@@ensure-electron-binary (#4394) — 把「装完依赖,electron 二进制就在」这条不变量补回来。
//
// electron 42 之前,`electron` 包带 postinstall 下载二进制,所以装完 `node_modules/electron/`
// 里就有 `path.txt` 和 `dist/`。仓里约 40 个 e2e/脚本文件是照着这个前提写的:
//   const bin = `${pkgDir}/dist/${readFileSync(`${pkgDir}/path.txt`)}`
// electron 42 起改成**首次 require 时才下载**,`electron@44` 的 package.json 里干脆没有 scripts。
// 于是全新的 CI 槽上 `pnpm install` 之后那两样都不存在,那 40 处一起 ENOENT
// (本地常常看不出来:开发机上早有人 require 过 electron,文件已被懒下载出来了)。
//
// ❌ 不去改那 40 处:那是个巨大且易错的 diff,而且它们的前提本身是合理的。
// ✅ 在这里显式补一次下载,把前提还原成真 —— 与 42 之前的行为等价,不是新增负担。
//
// 幂等:已经下载过就是一次 existsSync,不产生网络请求。

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

try {
  // electron 的 index.js 就是官方解析口:path.txt 或 dist 缺失时它同步补下载,
  // 并照顾 ELECTRON_OVERRIDE_DIST_PATH。已存在则直接返回路径。
  const binary = require('electron')
  console.log(`[ensure-electron-binary] ok → ${binary}`)
} catch (error) {
  // ❌ 不静默吞:吞掉的话故障会推迟到某个 e2e 里以 ENOENT 的形式冒出来,离真因两级远。
  console.error(`[ensure-electron-binary] 无法获得 electron 二进制。${repairHint()}`)
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

// Electron 44 用 @electron-internal/extract-zip 解压,它的 Windows 二进制动态链接微软 VC++ 运行库。
// 全新 Windows 没有 vcruntime140.dll,二进制加载失败,包只报一句笼统的「Cannot find native binding」,
// 让人去删 lockfile、设镜像 —— 都不是原因(#5671)。
// 解压跑在 electron 的 install.js 子进程里,传回这里的只剩「Electron failed to install correctly」,
// 看不到错误码,所以不看错误长什么样,直接查两件事实:解压组件在本进程里加载得起来吗,运行库在不在。
function repairHint() {
  if (process.platform === 'win32' && !unzipComponentLoads()) {
    const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
    const missing = ['vcruntime140.dll', 'vcruntime140_1.dll'].filter((dll) => !existsSync(join(system32, dll)))
    if (missing.length > 0) {
      return (
        `本机缺微软 VC++ 运行库(${system32} 下没有 ${missing.join('、')}),Electron 的解压组件加载不了。` +
        '装上后重跑 pnpm install:winget install Microsoft.VCRedist.2015+.x64' +
        '(或下载 https://aka.ms/vs/17/release/vc_redist.x64.exe)。'
      )
    }
  }
  return '离线/内网环境可先设 ELECTRON_MIRROR 或 ELECTRON_OVERRIDE_DIST_PATH 再重试。'
}

function unzipComponentLoads() {
  try {
    createRequire(require.resolve('electron/package.json'))('@electron-internal/extract-zip')
    return true
  } catch {
    return false
  }
}
