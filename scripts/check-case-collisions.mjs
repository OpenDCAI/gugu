#!/usr/bin/env node

// 大小写撞名:在 Linux(大小写敏感)上是两个文件,在 mac / Windows(大小写不敏感)上是同一个。
// 于是开发机四门全绿 → CI(mac runner)判红,报的还是看不懂的 TS1261「已包含的文件名只在大小写上不同」。
// 这不是假设 —— #5019 真撞了一次:contacts/ 下同时有 contactsDeviceSections.ts(纯逻辑)与
// ContactsDeviceSections.tsx(组件),d15 全绿,mac1 上渲染层构建 + 两个单测分片 + web e2e 一起红。
//
// 两条规则,都要:
//  A 整条路径折叠大小写后相同 → 在 mac 上就是同一个文件(任何文件类型,不限源码)。
//  B 去掉扩展名后折叠大小写相同(仅限模块文件)→ `import './X'` 这种不带扩展名的说明符在 mac 上解析不唯一。
//    #5019 撞的正是 B:两条路径差在 .ts / .tsx,规则 A 看不见它 —— 这也是为什么阳控必须拿真实例喂。
//
// 扫 git 树不扫工作区:未跟踪的临时文件不算债,与其它棘轮同一口径。

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const MODULE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/

/**
 * @param {string[]} paths 仓库相对路径
 * @returns {{ key: string, kind: 'same-file' | 'ambiguous-import', paths: string[] }[]}
 */
export function findCaseCollisions(paths) {
  /** @type {(entries: [string, string][]) => Map<string, Set<string>>} */
  const groupBy = (entries) => {
    const map = new Map()
    for (const [key, filePath] of entries) {
      let group = map.get(key)
      if (!group) {
        group = new Set()
        map.set(key, group)
      }
      group.add(filePath)
    }
    return map
  }

  const sameFile = groupBy(paths.map((p) => [p.toLowerCase(), p]))
  const modules = paths.filter((p) => MODULE_EXTENSIONS.test(p))
  const ambiguous = groupBy(modules.map((p) => [p.replace(MODULE_EXTENSIONS, '').toLowerCase(), p]))

  /** @type {{ key: string, kind: 'same-file' | 'ambiguous-import', paths: string[] }[]} */
  const hits = []
  const reported = new Set()
  for (const [key, group] of sameFile) {
    if (group.size < 2) continue
    const sorted = [...group].sort()
    hits.push({ key, kind: 'same-file', paths: sorted })
    reported.add(sorted.join('\0'))
  }
  for (const [key, group] of ambiguous) {
    if (group.size < 2) continue
    const sorted = [...group].sort()
    // 同一对已按「同一个文件」报过就不重复报,免得一处问题出两条噪音。
    if (reported.has(sorted.join('\0'))) continue
    // 只报**大小写**造成的:thing.ts 与 thing.tsx 去掉扩展名后逐字节相同,它不是靠大小写敏感撑着的,
    // 在哪个文件系统上都一样 —— 归到这道闸里就是误伤(阴控正是拿它把第一版实现判红的)。
    const distinctCasings = new Set(sorted.map((p) => p.replace(MODULE_EXTENSIONS, '')))
    if (distinctCasings.size < 2) continue
    hits.push({ key, kind: 'ambiguous-import', paths: sorted })
  }
  return hits.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

function main() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean)
  // 扫描面写出来:「0 命中」若来自一份空清单,那是仪器坏了不是仓库干净。
  console.log(`case-collisions: scanned=${tracked.length} tracked path(s)`)
  if (tracked.length === 0) {
    console.error('::error::git ls-files 返回空清单 —— 判据没有扫描面,读数作废')
    process.exit(1)
  }
  const collisions = findCaseCollisions(tracked)
  if (collisions.length === 0) return
  for (const { kind, paths } of collisions) {
    const why = kind === 'same-file'
      ? '在 mac / Windows 上是同一个文件'
      : '去掉扩展名后同名,不带扩展名的 import 在 mac / Windows 上解析不唯一'
    console.error(`::error::${paths.join(' vs ')} —— ${why}`)
  }
  console.error('::error::改名让它们在大小写之外也不同(❌ 只靠开发机的大小写敏感文件系统撑着)。')
  process.exit(1)
}

// 入口判定用 fileURLToPath,❌ 拼 `file://` + 路径 —— 路径里有空格/中文时拼出来的不是合法 URL
// (仓库有 check-file-url-paths 闸盯着这一点,我这道闸自己先被它抓了一次)。
const entry = process.argv[1]
if (entry && fileURLToPath(import.meta.url) === resolve(entry)) main()
