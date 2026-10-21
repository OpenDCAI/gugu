#!/usr/bin/env node
// @@@phone-web-dir — 手机包(Capacitor 的 webDir)= 网页版构建 dist/ 里手机够得着的那部分。
// 手机平台没有 sessionHost 能力(apps/desktop/src/platform/capacitor.ts;tests/unit/desktop/platform/capacitorNoSessionHost
// 守着这一条，变了就红),MainLayout 因此从不挂任务页，
// 任务页那个入口(rendererHtmlEntries.task)在手机上永远不会被加载。dist/ 同时是浏览器网页版的产物，那边有
// sessionHost、要任务页，所以不在构建里删，而是在拷进安卓之前按引用收一遍:
//   · 根 = dist/ 里除任务页入口以外的每个文件，以及 assets/ 之外的一切(public/ 拷来的、预装 App、App 运行时);
//   · assets/ 下带内容哈希的打包产物只在被某个已保留的文件按文件名引用时才保留(哈希名唯一，字面出现即引用;
//     rollup 的静态/动态 import、worker 的 new URL、CSS 的 url() 都写的是字面文件名)。
// 多算引用只会多留，不会误删。删掉的是只有任务页够得着的那些(Monaco、devicon、任务页代码)。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rendererHtmlEntries } from './product-build-entries.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/
const TEXT = /\.(html|js|mjs|css|json|svg)$/

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, root, out)
    else out.push(relative(root, path).replaceAll('\\', '/'))
  }
  return out
}

export function phoneFiles(files, read, taskEntry) {
  if (!files.includes(taskEntry)) throw new Error(`[phone-web-dir] dist 里没有任务页入口 ${taskEntry}:构建形状变了，先核再改`)
  if (!files.includes('index.html')) throw new Error('[phone-web-dir] dist 里没有 index.html')
  const hashed = new Map(files.filter((f) => HASHED_ASSET.test(f)).map((f) => [basename(f), f]))
  const keep = new Set()
  const stack = files.filter((f) => f !== taskEntry && !HASHED_ASSET.test(f))
  while (stack.length > 0) {
    const file = stack.pop()
    if (keep.has(file)) continue
    keep.add(file)
    if (!TEXT.test(file)) continue
    const text = read(file)
    for (const [name, path] of hashed) {
      if (!keep.has(path) && text.includes(name)) stack.push(path)
    }
  }
  return keep
}

function main() {
  const dist = join(repoRoot, 'dist')
  const out = join(repoRoot, 'dist-phone')
  const taskEntry = basename(rendererHtmlEntries.task)
  const files = walk(dist)
  const keep = phoneFiles(files, (f) => readFileSync(join(dist, f), 'utf-8'), taskEntry)
  rmSync(out, { recursive: true, force: true })
  let kept = 0
  let dropped = 0
  for (const file of files) {
    const size = statSync(join(dist, file)).size
    if (!keep.has(file)) { dropped += size; continue }
    kept += size
    mkdirSync(dirname(join(out, file)), { recursive: true })
    cpSync(join(dist, file), join(out, file))
  }
  if (!existsSync(join(out, 'index.html'))) throw new Error('[phone-web-dir] dist-phone/index.html 没写出来')
  console.log(`[phone-web-dir] dist-phone/ ${keep.size}/${files.length} 个文件,${kept} 字节;只有任务页够得着、没拷的 ${dropped} 字节`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
