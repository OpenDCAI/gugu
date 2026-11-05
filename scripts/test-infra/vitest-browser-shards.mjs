#!/usr/bin/env node
// @@@browser-shards — 浏览器 project 的全量运行拆成 N 个 `vitest run --shard=i/N` 进程并发跑。
//
// 为什么是多进程,不是 project 里的 fileParallelism(那条保持关着,见 vitest.config.ts):
// - 一个 vitest 进程里所有页面的模块请求、Playwright 路由拦截(vi.mock 走 context.route,拦下页面的每个请求)
//   都在**同一个 node 主线程**上转。实测 128 核机器上开 16 个页面,主线程 ~140% CPU、整机 77% 空闲,
//   全量只从 493s 降到 181–279s;累计 import 从 373s 涨到 2035–3369s。
// - 同一进程的所有页面共用一条 Playwright 连接,它每类对象最多留 1e4 个,超出就回收最老的 10%。
//   vitest 的 mock 路由在 `await module.resolve()` 之后才 `route.fulfill`;页面一多,等着的路由先被回收,
//   整轮以 `route.fulfill: The object has been collected to prevent unbounded heap growth` 中止(16 个页面就会)。
// 每个分片进程有自己的主线程、自己的 Playwright 连接,里面仍是一个页面、文件串行 —— 与不分片时的语义相同。
//
// 片数:可用核数(槽位机按 GUGU_CI_SLOT_COUNT 平分),最多 MAX_SHARDS。
// 只给全量用:除 `--project <名>` 之外还带了别的位置参数(文件过滤)就不分片,原样跑一个进程。
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { createInterface } from 'node:readline'

const MAX_SHARDS = 16
const args = process.argv.slice(2)
const filtered = args.some((arg, i) => !arg.startsWith('-') && args[i - 1] !== '--project')
const slots = Number(process.env.GUGU_CI_SLOT_COUNT)
const cores = Math.floor(availableParallelism() / (process.env.GUGU_CI_SLOT_ID && slots >= 1 ? slots : 1))
const total = filtered ? 1 : Math.max(1, Math.min(MAX_SHARDS, cores))

const children = []
const run = index => new Promise(resolve => {
  const shardArgs = total > 1 ? [`--shard=${index}/${total}`] : []
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...args, ...shardArgs], {
    stdio: total > 1 ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  children.push(child)
  if (total > 1) {
    const tag = `[${index}/${total}] `
    createInterface({ input: child.stdout }).on('line', line => process.stdout.write(tag + line + '\n'))
    createInterface({ input: child.stderr }).on('line', line => process.stderr.write(tag + line + '\n'))
  }
  child.on('exit', (code, signal) => resolve({ index, code: code ?? 1, signal }))
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => children.forEach(child => child.kill(signal)))

const results = await Promise.all(Array.from({ length: total }, (_, i) => run(i + 1)))
const failed = results.filter(r => r.code !== 0)
if (total > 1) {
  console.log(`\nbrowser shards: ${total - failed.length}/${total} passed` +
    (failed.length ? ` — failed: ${failed.map(r => `${r.index}/${total}${r.signal ? ` (${r.signal})` : ''}`).join(', ')}` : ''))
}
process.exit(failed.length ? 1 : 0)
