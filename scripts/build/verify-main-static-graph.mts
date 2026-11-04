import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// @@@4865 会话页主进程图只能在 main.ts 定好 userData / GUGU_HOME 之后才求值 —— 它的模块顶层就按 GUGU_HOME
// 算路径并留住(dependency-managers.ts:localDependencyManager 的 ownedMiseBinDirs、ensureUserBinDirsInPath)。
// 产物里 main.js 把它静态 require 的 chunk 全提到文件顶部,早于 main.ts 正文;从源码看不出来,所以查产物:
// 从 main.js 顺着静态 require 走一遍,碰到这些顶层语句就红。#751 曾把它拉进来 ⇒ 隔离实例与 beta 上
// 「装好了但找不到程序」。
const LOAD_TIME_HOME_READERS = [/^const localDependencyManager = new /m, /^ensureUserBinDirsInPath\(\);$/m]

export function assertMainStaticGraphDefersHomeReaders(distElectronDir: string): { files: string[] } {
  const seen = new Set<string>()
  const queue = ['main.js']
  while (queue.length > 0) {
    const file = queue.shift()!
    if (seen.has(file)) continue
    seen.add(file)
    const path = join(distElectronDir, file)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    const reader = LOAD_TIME_HOME_READERS.find((re) => re.test(source))
    if (reader) {
      throw new Error(
        `main.js statically loads ${file}, whose top level reads GUGU_HOME (${reader}) before main.ts sets it; load it with import() instead`,
      )
    }
    for (const [, dep] of source.matchAll(/^(?:const [\w$]+ = )?require\("\.\/([^"]+\.js)"\);$/gm)) queue.push(dep)
  }
  return { files: [...seen] }
}

if (process.argv[1] && process.argv[1].endsWith('verify-main-static-graph.mts')) {
  const distElectronDir = process.argv[2]
  if (!distElectronDir) throw new Error('usage: node scripts/build/verify-main-static-graph.mts <dist-electron>')
  const result = assertMainStaticGraphDefersHomeReaders(distElectronDir)
  process.stdout.write(`[main static graph] ${result.files.length} file(s) load before main.ts; none read GUGU_HOME\n`)
}
