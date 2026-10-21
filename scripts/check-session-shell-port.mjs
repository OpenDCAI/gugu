#!/usr/bin/env node
// @@@task-shell-port (#5012) — 会话页对外只许走两个类型化的口:宿主口 `rpc.*`、壳口 `shellPort()`。
//
// 判的是**语法形状**,不是通道清单:会话页与壳的源码里凡出现裸 `.invoke('…')` 字面量,或 `'sessionpage:'`
// 前缀的字符串字面量,即违规(壳口模块自身除外)。清单会漏(新加一条就得同步),形状不会 —— 通道名只能
// 从壳口常量拿,漏注册就是编译期的事。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCANNED_ROOTS = ['apps/desktop/src/session', 'apps/desktop/src/components/sessionpage']
/** 唯一允许出现壳通道名的文件。 */
export const SHELL_PORT_MODULE = 'apps/desktop/src/session/shared/lib/ipc/shell-port.ts'

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite'])
const RAW_INVOKE = /\.invoke\(\s*['"`]/
const SHELL_CHANNEL_LITERAL = /['"`]sessionpage:/

function isTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split(path.sep).includes('tests')
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry) || entry.startsWith('_')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (SOURCE_EXTENSIONS.has(path.extname(entry))) yield full
  }
}

/** @returns {{ file: string, line: number, text: string, rule: 'raw-invoke' | 'shell-channel-literal' }[]} */
export function scanSessionShellPort(root, { roots = SCANNED_ROOTS, allow = [SHELL_PORT_MODULE] } = {}) {
  const violations = []
  const allowed = new Set(allow.map((p) => path.resolve(root, p)))
  for (const rel of roots) {
    const dir = path.resolve(root, rel)
    let entries
    try {
      entries = [...walk(dir)]
    } catch {
      continue
    }
    for (const file of entries) {
      if (allowed.has(file) || isTestFile(path.relative(root, file))) continue
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((text, index) => {
        const trimmed = text.trimStart()
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
        const rule = RAW_INVOKE.test(text) ? 'raw-invoke' : SHELL_CHANNEL_LITERAL.test(text) ? 'shell-channel-literal' : null
        if (rule) violations.push({ file: path.relative(root, file), line: index + 1, text: trimmed, rule })
      })
    }
  }
  return violations
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const violations = scanSessionShellPort(root)
  if (violations.length === 0) {
    console.log(`check-session-shell-port: OK (${SCANNED_ROOTS.join(', ')})`)
    return 0
  }
  console.error('check-session-shell-port: 任务页/壳源码里出现裸 invoke 字面量或壳通道名 —— 改走 rpc.* / shellPort():')
  for (const v of violations) console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.text}`)
  return 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main()
}
