#!/usr/bin/env node
// 保留依赖树的 CI 工作区(mac1 池的 setup-ci-slot、Windows 的 beta-dogfood / cd-release)跨 job 复用
// node_modules。复用成立的前提只有一条:**上一次安装走完了**。
//
// pnpm 判「Already up to date」只比 pnpm-lock.yaml 与 node_modules/.pnpm/lock.yaml,不看文件系统。
// 一次半路失败的安装已经把一部分链接改到它自己的锁上,却还没写 lock.yaml —— 之后每个 job 都判成
// up to date,带着悬空链接往下跑。2026-09-30 实测:PR #6847 的 `file:` 依赖指向 runner 上没有的
// 兄弟仓,install 在 ENOENT 上 exit 254,留下指向 `@codemirror+view@6.43.13_patch_hash=…` 空目录的
// 链接;dev 的 desktop build 随后在 16 个槽里的 14 个上 `failed to resolve import "@codemirror/view"`。
//
// 所以完成戳只在安装成功之后写;进来时树在、戳不在 ⇒ 这棵树不可信,工作区里所有 node_modules 整个清掉。
// ❌ 不按 lockfile 哈希决定清不清:分支之间的锁本来就不同,从一棵走完的树出发 pnpm 的增量安装是对的,
//    按哈希清等于每换一次分支整棵重链(setup-ci-slot 里记着 2m24.6s)。
// ❌ 不是「装失败了再装一次」:失败的那个 job 照常红,是下一个进来的 job 不接这棵树。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const STAMP = path.join('node_modules', '.gugu-install-complete')

/** 工作区里每一个 node_modules(不进 node_modules 内部,也不进 .git;目录的符号链接不跟)。 */
export function nodeModulesDirs(root) {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git') continue
      const child = path.join(dir, entry.name)
      if (entry.name === 'node_modules') found.push(child)
      else walk(child)
    }
  }
  walk(root)
  return found
}

/** 安装之前:上一次没走完 ⇒ 清掉整棵树;走完了 ⇒ 撤掉戳,这一次走完才重新立。 */
export function beforeInstall(root) {
  const stamp = path.join(root, STAMP)
  if (fs.existsSync(path.join(root, 'node_modules')) && !fs.existsSync(stamp)) {
    const dirs = nodeModulesDirs(root)
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
    return { cleared: dirs }
  }
  fs.rmSync(stamp, { force: true })
  return { cleared: [] }
}

/** 安装成功之后立戳。判据只看戳在不在,戳是空文件。 */
export function afterInstall(root) {
  fs.writeFileSync(path.join(root, STAMP), '')
}

function runCli() {
  const root = process.cwd()
  const mode = process.argv[2]
  if (mode === '--before-install') {
    const hadTree = fs.existsSync(path.join(root, 'node_modules'))
    const { cleared } = beforeInstall(root)
    if (cleared.length) {
      console.log(`::warning::上一次安装没走完(没有 ${STAMP}),这棵依赖树不接:清掉 ${cleared.length} 个 node_modules 后整棵重装`)
    } else {
      console.log(hadTree ? 'kept tree: the previous install completed' : 'no dependency tree yet: fresh install')
    }
  } else if (mode === '--after-install') {
    afterInstall(root)
    console.log('install complete')
  } else {
    console.error('usage: node scripts/ci-kept-tree.mjs --before-install | --after-install')
    process.exit(2)
  }
}

// 按真实路径比:经符号链接调用时(macOS 的 /tmp 就是 /private/tmp)按字面比会对不上,脚本什么都不做就 exit 0。
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) runCli()
