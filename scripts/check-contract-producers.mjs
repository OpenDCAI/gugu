#!/usr/bin/env node
// 「读了但从没被写过」的契约字段闸。
//
// ## 它防的是哪一种坏
//
// 这一族在这个仓里反复出现(字段两端都在、中间没人搬;副本停在旧形状;zod 静默剥字段)。
// 共同结构是:**同一份事实的两端各自成立,而它们之间那一跳没有任何机制保证**。
// 这个脚本只钉住其中最机械、也最容易漏的一种:**声明了、有人读、没人写**。
//
// ## 判据怎么算数
//
// 生产者 = 在**非 schema、非测试**的源码里,这个名字以对象键的形式出现(`name:` 或 `name =`)。
// ⚠️ 这条判据是**保守**的:它只能证明"有人写过",不能证明"写在对的那条路上"
//    (`mcpDisabled` 那次就是有人写、但中间那一跳没搬)。⇒ 它不是万灵药,
//    它把这一族里**最便宜的那一半**变成编译期之外的一条红线。
// ⚠️ 反过来它**不会**误伤:一个字段只要有任何一处写,就不在这个闸的射程里。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** 受管的契约文件。新增一个 = 声明「这份 schema 里的字段都必须有生产者」。 */
const CONTRACTS = ['packages/session-core/src/acp/api/runtime-contract.ts']

/**
 * 明确豁免的字段 + 理由。**每一条都要写清为什么没有生产者也不算坏。**
 * ❌ 不许为了让闸变绿而往这里加名字 —— 加一条就是声明"这个字段没人写是对的"。
 */
const EXEMPT = new Map([])

const ROOT = process.cwd()
const SEARCH_ROOTS = ['apps', 'packages']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.vite'])
const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs'])

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (CODE_EXT.has(path.extname(entry))) out.push(full)
  }
  return out
}

/** `foo: z.string().optional(),` / `foo: z.boolean(),` —— schema 里声明的字段名。 */
function contractFields(source) {
  const names = []
  for (const match of source.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\./gm)) {
    names.push(match[1])
  }
  return [...new Set(names)]
}

function isTest(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes(`${path.sep}e2e${path.sep}`)
}

const files = SEARCH_ROOTS.flatMap((rel) => walk(path.join(ROOT, rel), []))
const problems = []

for (const contract of CONTRACTS) {
  const abs = path.join(ROOT, contract)
  const fields = contractFields(readFileSync(abs, 'utf8'))
  if (fields.length === 0) {
    problems.push(`${contract}: 一个字段都没解析出来 —— 判据本身失效了,先修判据`)
    continue
  }
  for (const field of fields) {
    if (EXEMPT.has(field)) continue
    const writer = new RegExp(`(^|[^.\\w])${field}\\s*[:=][^:=]`)
    const produced = files.some((file) => {
      if (file === abs || isTest(file)) return false
      return writer.test(readFileSync(file, 'utf8'))
    })
    if (!produced) {
      problems.push(
        `${contract}: 契约字段 '${field}' **没有任何生产者** —— 声明了、可能有人读,`
        + ' 而没有一处写它:声明、消费与实际传递可能已经脱节。'
      )
    }
  }
  console.log(`contract-producers: ${contract} fields=${fields.length}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  process.exit(1)
}
console.log('contract-producers: OK')
