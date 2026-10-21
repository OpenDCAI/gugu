#!/usr/bin/env node
// @@@eslint-cache (#6270) — `pnpm lint` 的 eslint 段带上结果缓存:整仓冷跑约 42s,缓存热时约 2s。
//
// 缓存对不对,取决于「什么变了会让它作废」。ESLint 8 的判据(lib/cli-engine/lint-result-cache.js
// 的 hashOfConfigFor)是:文件内容(--cache-strategy content)+ 该文件算出来的配置 + eslint 版本 + node 版本。
// ⚠️ 它**不含插件 / parser 的版本** —— 升级 @typescript-eslint 之类只动 lockfile、不动配置,
//    旧缓存会继续放行。所以缓存目录按 pnpm-lock.yaml 的内容分桶:lockfile 一变就是一只空桶。
// ⚠️ 必须是 content 策略:CI 每次 checkout 都会刷新 mtime,metadata 策略等于永远冷。
// 本仓没有类型感知规则(无 parserOptions.project),每个文件的结论只取决于它自己 —— 这是按文件缓存成立的前提。
// 哪天加了类型感知规则,这个前提就破了,必须回来重新判断(改一个文件会改变别的文件的结论)。
//
// 缓存放在 node_modules/.cache 下:CI 槽的清理是 `git clean -ffdx -e node_modules`,于是它按槽存活;
// 本地同理。GUGU_ESLINT_NO_CACHE=1 可整个关掉。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repoRoot, 'package.json'))

export const CACHE_ROOT = join('node_modules', '.cache', 'eslint')

/** 桶名 = lockfile 内容的短哈希。插件/parser 版本全由 lockfile 决定,所以它是缓存键里缺的那一项。 */
export function cacheBucket(root = repoRoot) {
  return createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex').slice(0, 16)
}

/** 组装 eslint 参数;noCache 时原样透传(与缓存前的命令一字不差)。 */
export function eslintArgs(args, { bucketDir, noCache }) {
  if (noCache) return args
  // 目录必须以 / 结尾,eslint 才把它当目录(在里面按 cwd 哈希起文件名)。
  return [...args, '--cache', '--cache-strategy', 'content', '--cache-location', `${bucketDir}/`]
}

function main() {
  const noCache = process.env.GUGU_ESLINT_NO_CACHE === '1'
  const bucket = cacheBucket()
  const cacheRoot = join(repoRoot, CACHE_ROOT)
  const bucketDir = join(cacheRoot, bucket)
  if (!noCache) {
    mkdirSync(bucketDir, { recursive: true })
    // 旧 lockfile 的桶不会再命中,留着只占盘:只保留当前这一只。
    for (const entry of readdirSync(cacheRoot)) {
      if (entry !== bucket) rmSync(join(cacheRoot, entry), { recursive: true, force: true })
    }
  }
  const eslintBin = join(dirname(require.resolve('eslint/package.json')), 'bin', 'eslint.js')
  const result = spawnSync(process.execPath, [eslintBin, ...eslintArgs(process.argv.slice(2), { bucketDir, noCache })], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
