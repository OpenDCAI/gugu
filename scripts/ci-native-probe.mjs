#!/usr/bin/env node
// CI 槽位的原生模块判据 —— 槽的 node_modules 跨 job 存活,而打包 job 会把 better-sqlite3 /
// node-pty 就地重编成 Electron 的 ABI,下一个落到同一个槽的源码 job 再加载就炸。
//
// ⚠️ 判据**不内联在 action.yml 的 `node -e` 里**,这一条是这个文件存在的理由:
//    判据自己出过一次静默失效(见 NATIVE_PROBES 上面那段),而内联在 YAML 字符串里的代码
//    没有任何测试够得着 —— 它变成空转时,唯一的报警方式是几小时后有人来查一条随机红。
//    搬出来之后 tests/unit/scripts/ciNativeProbe.test.ts 每条 PR 都在替它站岗。

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * 判据是「**产品真正加载到的那一份 addon 能不能打开**」。这句话有两半,少一半都会失效,
 * 而两半各自都被实测打脸过一次 —— 两次的形态正好相反,所以这里把两条一起钉住:
 *
 * 一、必须走**产品那条解析路**(按包名 require),❌ 不是某个写死路径上的 .node 文件。
 *     node-pty 1.1.0 随包发 `prebuilds/<platform>-<arch>/`,加载顺序是
 *     build/Release → build/Debug → prebuilds(lib/utils.js)。槽里**没有** build/ 是正常态
 *     (实测 mac1-ci-04/07/08/12 就没有、一直全绿),按写死路径判会把它误判成坏。
 *
 * 二、必须**真的把 addon 打开**,❌ 「require 成功」不等于「打开了」。
 *     better-sqlite3 的 addon 是**懒加载**的:lib/database.js 到 `new Database()` 里才调
 *     bindings(),所以 `require('better-sqlite3')` 的 dlopen 次数是 **0** —— 那句话对 ABI
 *     漂移完全无感,不管槽里躺着哪个 ABI 的二进制它都说好。
 *
 * 这正是 #5713 的成因:2026-09-16 06:33 UTC 判据为了修第一条改成按包名 require,四小时后
 * 同一个 job 里闸门 11:45:37Z 报 "native ABI ok",测试 11:46:57Z 就炸在
 * NODE_MODULE_VERSION 149 vs 137(mac1-ci-14,run 35092015672)。修好一半、瞎掉另一半。
 *
 * ⇒ 所以每个包登记一条「**真的用起来**」的动作,并且由 dlopen 计数来证明它真的用起来了:
 *   exercise 跑完一个 .node 都没打开 ⇒ **判坏**并说清原因,❌ 不是判好。
 *   这一条是结构性的 —— 它让「判据悄悄退化成空转」不可能再发生,而那正是这次的成因。
 *   新增原生依赖时也由它兜底:忘了登记 exercise 会响亮地红,❌ 不会变成一条没人守的路。
 */
export const NATIVE_PROBES = {
  // 懒加载:必须真的开一个库,require 本身一个 .node 都不打开。
  'better-sqlite3': (require) => {
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
  },
  // 这个在 require 时就打开 addon。下面的 dlopen 断言会一直盯着这句话是否还成立 ——
  // 哪天上游改成懒加载,红的是这里,不是几小时后某条随机 PR。
  'node-pty': (require) => {
    require('node-pty')
  },
}

const firstLine = (value) => String(value).split('\n')[0]

/**
 * 跑一遍判据。返回 { bad, attempts },attempts 里每个包记着它开了哪些 .node ——
 * dlopen 是**尝试**就计数(打开失败也算),因为「这个 exercise 到底碰没碰到原生代码」
 * 是与 ABI 对不对无关的性质,测试要在一棵被污染的树上也能判它。
 */
export function probeNativeModules({
  repoRoot = process.cwd(),
  probes = NATIVE_PROBES,
  log = console.log,
} = {}) {
  // 从仓根解析,与产品加载它们的位置一致(实测 workspace 各包都落到同一份 .pnpm 目录)。
  const requireFromRepo = createRequire(path.join(repoRoot, 'ci-native-probe.entry.cjs'))
  // ⚠️ 存下**原函数本身**再还回去,❌ 别存 .bind(process) 的副本:那样还回去的是另一个对象,
  //    反复调用会一层层套 bind,也会把别人先打的补丁悄悄换掉(单测里 toBe 那条抓的就是它)。
  const originalDlopen = process.dlopen
  const opened = []
  process.dlopen = (module, filename, flags) => {
    opened.push(filename)
    return originalDlopen.call(process, module, filename, flags)
  }
  try {
    const attempts = []
    let bad = 0
    for (const name of Object.keys(probes)) {
      const exercise = probes[name]
      const before = opened.length
      let failure = ''
      try {
        exercise(requireFromRepo)
      } catch (error) {
        failure = firstLine(error?.message ?? error)
      }
      const loaded = opened.slice(before)
      attempts.push({ name, loaded, failure })
      if (failure) {
        bad += 1
        log(`native load failed: ${name} :: ${failure}`)
        continue
      }
      if (loaded.length === 0) {
        bad += 1
        log(
          `native probe proved nothing: ${name} —— exercise 跑完一个 .node 都没打开,` +
            '这条判据是空转的。给它换一个真正用到 addon 的动作(例如 better-sqlite3 要 new Database)。',
        )
      }
    }
    return { bad, attempts }
  } finally {
    process.dlopen = originalDlopen
  }
}

const readdirSafe = (dir) => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 这棵树里**会被 node-gyp 从源码编出来**的包 —— 也就是 ABI 会漂的那一批。判据两半的合取:
 * ① 写在 package.json 的 `pnpm.onlyBuiltDependencies` 里(否则 pnpm 根本不跑它的编译脚本);
 * ② 树里真的有 binding.gyp(否则它的 install 只是下二进制,例如 electron 自己)。
 *
 * ❌ 别拿「树里有 .node 文件」当判据:实测这棵树里有 20 多个包带 .node,绝大多数是 N-API 的
 *    预编译平台包(@rollup/rollup-darwin-*、@swc/core-*、fsevents、lightningcss-* …)。
 *    N-API 的 ABI 跨 Node 版本、跨 Electron 都稳定,它们根本不会漂,收进来只会制造假红。
 *
 * 用来给 NATIVE_PROBES 做覆盖对账:有人新加一个从源码编的原生依赖却没登记 exercise,
 * 槽里就多出一条没人守的路 —— 那是 #5713 的同形状问题,只是换了个包。
 * 对账放在单测(PR 时红),❌ 不放在槽闸门里 —— 那会让全池的 job 一起红。
 */
export function discoverAbiFragilePackages(repoRoot = process.cwd()) {
  // ❌ 这里不吞异常:读不到 package.json 就该当场炸。吞掉会返回空名单,而空名单在覆盖对账里
  //    的含义是「这棵树没有会漂的原生依赖」—— 把「我没读到」说成「它不存在」,正是 #5713 的病。
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const allowed = manifest?.pnpm?.onlyBuiltDependencies ?? []
  const pnpmDir = path.join(repoRoot, 'node_modules/.pnpm')
  const entries = readdirSafe(pnpmDir)
  return allowed
    .filter((name) =>
      entries.some((entry) => fs.existsSync(path.join(pnpmDir, entry, 'node_modules', name, 'binding.gyp'))),
    )
    .sort()
}

/**
 * 陈旧的 build/ 是**可丢的**:随包 prebuild 在的(node-pty),清掉它加载自会落回去;
 * 没有随包 prebuild 的(better-sqlite3),后面那次 rebuild 会重新编出来。
 * 清掉也是让 node-gyp 不会拿着旧 config.gypi 增量编 —— mac1-ci-15 实测过一份 target_arch=x64
 * 的 config.gypi,重建多少次产物都还是 x86_64,落到那个槽的 job 永远红。
 */
export function dropStaleBuilds({ repoRoot = process.cwd(), names = Object.keys(NATIVE_PROBES), log = console.log } = {}) {
  const pnpmDir = path.join(repoRoot, 'node_modules/.pnpm')
  const dropped = []
  for (const entry of readdirSafe(pnpmDir)) {
    for (const name of names) {
      const build = path.join(pnpmDir, entry, 'node_modules', name, 'build')
      if (!fs.existsSync(build)) continue
      log(`  dropping stale build dir: ${path.relative(repoRoot, build)}`)
      fs.rmSync(build, { recursive: true, force: true })
      dropped.push(build)
    }
  }
  return dropped
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--probe'
  if (mode === '--list') {
    // 包名的唯一事实源:action 里那条 `pnpm rebuild` 从这里取,❌ 别在 YAML 里再抄一份。
    console.log(Object.keys(NATIVE_PROBES).join(' '))
  } else if (mode === '--drop-stale-builds') {
    dropStaleBuilds({})
  } else {
    const { bad, attempts } = probeNativeModules({})
    if (bad > 0) process.exit(1)
    const total = attempts.reduce((sum, attempt) => sum + attempt.loaded.length, 0)
    console.log(
      `native ABI ok (node ${process.version}, modules ${process.versions.modules}, ` +
        `${attempts.length} 个包共打开 ${total} 个 .node)`,
    )
  }
}
