#!/usr/bin/env node
// @@@ci-concurrent (#6270) — 一个 CI step 里并发跑几条**互不依赖**的命令,全部跑完再判。
//
// 为什么要它:session-db 这个 job 的几段(DB 集成、迁移、两个浏览器 project、tooling)彼此没有数据
// 依赖,串着跑时墙钟是各段之和。vitest 4 的浏览器模式还会把同一次调用里的多个 browser project
// **排队**跑(实测 mac1 2026-09-23:chat-ui 0–39s、session-browser 42–143s,首尾相接),所以拆成
// 独立进程是唯一能让它们重叠的办法。
//
// 契约(每一条都是为了「并发不许换来更少的信息或更松的判定」):
//   - 每条命令都跑到底,❌ 不因为兄弟先红就杀掉它 —— 一次 run 要报出全部的红,不是第一条红;
//   - 任一条非零退出(或被信号杀掉)⇒ 本脚本非零退出;
//   - 输出逐行实时转发并加 `[label]` 前缀:WorkerAttributionReporter 的在飞心跳要实时可见,
//     否则卡住时看不出卡在哪;
//   - 结尾打一张「label / 退出码 / 耗时」表,红的那条排在最显眼处。
//
// 用法: node scripts/ci-concurrent.mjs 'db=pnpm session:test:db && pnpm session:test:migrations' 'browser=pnpm exec vitest run --project session-browser'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function parseJobs(argv) {
  if (argv.length === 0) throw new Error('ci-concurrent: 至少给一条 label=command')
  const seen = new Set()
  return argv.map((arg) => {
    const eq = arg.indexOf('=')
    if (eq <= 0 || eq === arg.length - 1) throw new Error(`ci-concurrent: 参数必须是 label=command,收到 ${JSON.stringify(arg)}`)
    const label = arg.slice(0, eq)
    if (seen.has(label)) throw new Error(`ci-concurrent: label 重复 ${label}`)
    seen.add(label)
    return { label, command: arg.slice(eq + 1) }
  })
}

export function runConcurrent(jobs, { write = (line) => process.stdout.write(line), env = process.env } = {}) {
  const children = []
  const results = jobs.map(({ label, command }) => new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('/bin/bash', ['-c', `set -euo pipefail\n${command}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on('line', (line) => write(`[${label}] ${line}\n`))
    }
    child.on('error', (error) => {
      write(`[${label}] spawn failed: ${error.message}\n`)
      resolve({ label, code: 127, signal: null, seconds: (Date.now() - started) / 1000 })
    })
    child.on('close', (code, signal) => {
      resolve({ label, code: code ?? 1, signal, seconds: (Date.now() - started) / 1000 })
    })
  }))
  const forward = (signal) => {
    for (const child of children) child.kill(signal)
  }
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  return Promise.all(results).finally(() => {
    process.removeListener('SIGINT', forward)
    process.removeListener('SIGTERM', forward)
  })
}

export function summarize(results) {
  const failed = results.filter((r) => r.code !== 0 || r.signal)
  const lines = results.map((r) => {
    const verdict = r.code === 0 && !r.signal ? 'ok  ' : 'FAIL'
    return `${verdict} ${r.label}  exit=${r.signal ?? r.code}  ${r.seconds.toFixed(1)}s`
  })
  return { ok: failed.length === 0, failed: failed.map((r) => r.label), text: lines.join('\n') }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const jobs = parseJobs(process.argv.slice(2))
  const results = await runConcurrent(jobs)
  const { ok, failed, text } = summarize(results)
  process.stdout.write(`\n=== ci-concurrent summary ===\n${text}\n`)
  if (!ok) {
    for (const label of failed) process.stdout.write(`::error::ci-concurrent: ${label} failed\n`)
    process.exit(1)
  }
}
