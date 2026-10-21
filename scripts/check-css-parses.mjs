#!/usr/bin/env node

// @@@css-blind-gate (Refs #6103) — 四门对 CSS 语法错误是全盲的。
//
// 实撞:2026-09-22 的 token 批次往 `tokens.css` 的注释里写了 `text-*/font-*`,中间那个 `*/`
// 把 CSS 注释**提前闭合**,整个文件 postcss 解析失败 —— 而 `typecheck` / `lint` / `test:unit`
// 三门**全绿**,一个都没照出来。照出来的是 `build:renderer`(它真跑一次 PostCSS)与
// `session-browser`(它真挂一次样式表),而这两样都不在 PR 的必过门里。
//
// 病根不是谁粗心:那三门根本不读 CSS —— tsc 不认识 .css,eslint 的解析器不管 .css,
// vitest 只在真挂样式的那几个 project 里才碰它。一个没人读的文件,写错了当然没人红。
//
// 这道闸只做一件事:把每个 .css 交给 postcss 真解析一遍,语法错就红。
// ❌ 它不判样式对不对(那是 check-ui-visual-spec 的活),只判「这个文件还能不能被编译器读懂」。

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.next', '.vite', 'build', 'coverage', 'dist', 'dist-electron',
  'node_modules', 'out', 'playwright-report', 'test-results', 'archive', 'tmp',
])
// 别的判据拿「坏 CSS」当样本(tests/fixtures/ui-state-debt-check/invalid-css),那是它们的阳性对照,
// 不是产品文件 ⇒ 这里跳过。❌ 别为了让这道闸变绿去改那些样本。
const SKIPPED_PATH_FRAGMENTS = ['/tests/fixtures/']

function collect(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.storybook') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      collect(full, found)
    } else if (entry.isFile() && path.extname(entry.name) === '.css') {
      const posix = full.split(path.sep).join('/')
      if (SKIPPED_PATH_FRAGMENTS.some((fragment) => posix.includes(fragment))) continue
      found.push(full)
    }
  }
  return found
}

const files = collect(repoRoot).sort()
const failures = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  try {
    // `from` 让报错带上真实路径;不做任何插件,只要解析器点头。
    postcss.parse(source, { from: file })
  } catch (error) {
    const rel = path.relative(repoRoot, file)
    const where = error.line ? `:${error.line}:${error.column ?? 0}` : ''
    failures.push(`${rel}${where} — ${error.reason ?? error.message}`)
  }
}

if (failures.length > 0) {
  console.error('css parse guard FAILED — 这些文件 PostCSS 读不懂,构建时会整份丢掉:')
  for (const line of failures) console.error(`  ${line}`)
  console.error('\n⚠️ 最常见的一种:注释里写了 `*/`(比如 `text-*/font-*`),把注释提前闭合。')
  process.exit(1)
}

console.log(`css parse guard passed: ${files.length} stylesheet(s) parsed`)
