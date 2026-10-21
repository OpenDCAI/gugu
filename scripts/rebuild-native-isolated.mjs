#!/usr/bin/env node
// @@@native-rebuild-isolated (#6270) — 跑一遍 `rebuild:native`(electron-rebuild + verify-dev-native),
// 但**不把槽里的原生模块留在 Electron ABI 上**。
//
// 为什么需要它:CI 槽的 node_modules 跨 job 存活。`build:app` 末尾的 rebuild:native 把
// better-sqlite3 / node-pty 就地重编成 Electron ABI,下一个落到这个槽的源码 job 就得走
// setup-ci-slot 的修复(拥挤时 148s)。这里把两个包各自的 `build/` 先挪开,重编 + 验证完再挪回去 ——
// 重编产物落在一个全新的 `build/` 里,原来那份(node ABI)一个字节都没被碰过。
//
// ⚠️ 挪开而不是复制:pnpm 的包文件可能是 store 的硬链接,就地覆盖会顺手改坏 store 里那份。
//    rename 不写文件内容,不存在这个问题。
// ⚠️ job 被取消时 finally 不保证跑 —— 所以每次开头先把上一次残留的 stash 还原回去;
//    还原不了的情形仍由 setup-ci-slot 的修复兜底(判据 ci-native-probe.mjs 与之同一份)。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(repoRoot, 'package.json'))
const { NATIVE_MODULES } = require('./scripts/rebuild-native.cjs')

export const STASH_SUFFIX = '.gugu-native-stash'
const ABSENT_MARKER = 'ABSENT'

/** 包根目录:从入口文件往上找到 name 对得上的 package.json(❌ 不猜入口在几层之下)。 */
export function packageRoot(name, req = require) {
  let dir = dirname(req.resolve(name))
  while (dir !== dirname(dir)) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir
    dir = dirname(dir)
  }
  throw new Error(`[rebuild-native-isolated] 找不到 ${name} 的包根`)
}

/**
 * 把 `<pkg>/build` 挪到 `<pkg>/build.gugu-native-stash`。原来没有 build/ 的(node-pty 正常态就是走
 * prebuilds/),挪一个标记文件过去,还原时据此删掉重编产物,❌ 不能留下一个会盖住 prebuilds 的 build/。
 */
export function stashBuild(pkgDir) {
  const build = join(pkgDir, 'build')
  const stash = build + STASH_SUFFIX
  if (existsSync(stash)) throw new Error(`[rebuild-native-isolated] ${stash} 已存在,先还原再挪`)
  // 标记是一个普通文件,真 stash 是目录 —— 两者靠类型区分。
  if (existsSync(build)) renameSync(build, stash)
  else writeFileSync(stash, ABSENT_MARKER)
}

/**
 * electron-rebuild 在 build/ 之外也会留东西(实测:`bin/<platform>-<arch>-<abi>/` 与一个空的
 * `node-addon-api@x/`)。重编前记下包根的顶层条目,还原时把**这次新长出来的**删掉 —— 只删自己造的。
 */
export function snapshotEntries(pkgDir) {
  return new Set(readdirSync(pkgDir))
}

export function removeNewEntries(pkgDir, before) {
  const removed = []
  for (const entry of readdirSync(pkgDir)) {
    if (before.has(entry) || entry === 'build' || entry === 'build' + STASH_SUFFIX) continue
    rmSync(join(pkgDir, entry), { recursive: true, force: true })
    removed.push(entry)
  }
  return removed
}

/** 把重编产物删掉、原来的 build/ 挪回来(原来没有就不留 build/)。返回这次是否真还原了东西。 */
export function restoreBuild(pkgDir) {
  const build = join(pkgDir, 'build')
  const stash = build + STASH_SUFFIX
  if (!existsSync(stash)) return false
  rmSync(build, { recursive: true, force: true })
  if (statSync(stash).isDirectory()) renameSync(stash, build)
  else rmSync(stash, { force: true })
  return true
}

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: 'inherit', env: process.env })
  if (result.status !== 0) throw new Error(`[rebuild-native-isolated] ${label} 失败(exit ${result.status ?? result.signal})`)
}

function main() {
  const pkgDirs = NATIVE_MODULES.split(',').map((name) => packageRoot(name))
  // 上一次被取消留下的 stash:先还原,本次从干净的槽状态开始。
  for (const dir of pkgDirs) {
    if (restoreBuild(dir)) console.log(`[rebuild-native-isolated] 还原了上一次残留的 stash:${dir}`)
  }
  const before = new Map(pkgDirs.map((dir) => [dir, snapshotEntries(dir)]))
  const restoreAll = () => {
    for (const dir of pkgDirs) {
      restoreBuild(dir)
      removeNewEntries(dir, before.get(dir))
    }
  }
  for (const dir of pkgDirs) stashBuild(dir)
  let failure = null
  const onSignal = (signal) => {
    restoreAll()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    run('rebuild-native', ['scripts/rebuild-native.cjs'])
    run('verify-dev-native', ['scripts/verify-dev-native.mjs'])
  } catch (error) {
    failure = error
  } finally {
    restoreAll()
  }
  // 还原之后必须复验:槽要回到 node ABI,否则下一个 job 照样付修复的钱。
  run('ci-native-probe(还原后复验)', ['scripts/ci-native-probe.mjs'])
  if (failure) {
    console.error(failure.message)
    process.exit(1)
  }
  console.log('[rebuild-native-isolated] Electron ABI 重编与验证通过;槽已还原为 node ABI')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
