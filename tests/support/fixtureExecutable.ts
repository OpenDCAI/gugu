import { chmodSync, existsSync, linkSync, rmSync, writeFileSync } from 'node:fs'

import { cachedFixtureExecutable } from './cachedFixtureExecutable'

/**
 * 在任意路径上放一个「测试用的可执行桩」,而**不新建一个可执行文件**。
 *
 * ## 为什么不能直接写一个文件
 *
 * macOS 对**被 execve 的那个文件**的首次执行收一道全机串行的安全检查,按 inode 缓存。
 * 2026-09-10 在 mac1 的对照(每组 5 个全新文件,负载 28,中位数)把它钉死了:
 *
 * | 做法 | 首次执行 |
 * |---|---|
 * | 全新文件直接执行 | 470 ms |
 * | 同一个文件第二次执行 | 40 ms |
 * | 清扩展属性 / ad-hoc 签名 | 1148 ms / 471 ms(都没用) |
 * | 先 spawn 再 100ms 内杀掉,然后执行 | 1366 ms(抢跑不算付过) |
 * | 同一份内容交给已经暖的解释器 | 41 ms |
 *
 * 并发时这道队列会涨到 3–11 秒,直接撞穿产品那些 10 秒量级的 `--version` 预检预算 ——
 * 这就是 CI 上 `researchClosureContracts` / `deployGateway3875` / `deployMigrations`
 * 那一族假红的来源(#4918 / #5360)。
 *
 * [[cachedFixtureExecutable]] 用内容寻址解决了「正文稳定」的那一半:同一份正文全仓共用一个
 * inode。但很多桩的正文里必须嵌**逐用例的路径**(台账文件、临时仓根、场景开关),内容每跑一次
 * 都不同,寻址等于没设。
 *
 * ## 做法:一个已经暖的蹦床,硬链接到任意名字
 *
 * 蹦床本身正文固定(所以走内容寻址、全机只付一次费),它把**同名 `.body` 文件当参数**交给
 * `/bin/bash` —— 参数不是被 execve 的文件,不收费(上表最后一行)。硬链接不产生新 inode,
 * 于是「叫什么名字、正文是什么」都自由,而每次执行都走已经暖的那条路。
 *
 * mac1 实测:蹦床自己首次 423ms,硬链接成两个全新名字后执行 **6–7ms**,
 * 同内容但真新建的对照文件 175–411ms。argv 透传与退出码均正确。
 *
 * ## 用法
 *
 * ```ts
 * fixtureExecutable(join(bin, 'docker'), `echo "$@" >> ${callsLog}`)
 * ```
 *
 * 正文可以按 bash 直接写(不带 shebang,蹦床用 `/bin/bash` 跑),也可以是从仓里原样复制来的
 * 脚本 —— 带 shebang 时蹦床按它声明的解释器分派,所以 `.sh` 与 `.mjs` 都能照原样工作。
 *
 * ## 边界
 *
 * - 硬链接要求与蹦床同一个文件系统。跨设备(EXDEV)时自动退回「直接写文件」,行为与从前一致 ——
 *   只是又要付那笔费,所以 ❌ 别把桩目录放到别的卷上。
 * - `$0` 取的是被调用的那个路径,所以桩靠 PATH 被找到时也能定位到自己的 `.body`。
 * - ❌ 不适用于「就是要验 execve 失败」的用例(比如把解释器从 PATH 里拿掉):蹦床总是能起来,
 *   失败点会从 execve 挪到蹦床内部,判据的含义就变了。那种用例请继续直接写文件。
 * - ❌ 不适用于**会被别的解释器当参数读**的文件(典型是 `node foo.mjs` 里的那个 .mjs):
 *   那个解释器会去解析蹦床的 bash 源码而不是你的正文。这类文件本来就不被 execve、
 *   压根不收首次执行费,直接 `writeFileSync` 就好。
 */

/**
 * 蹦床正文。**逐字稳定**是它的全部价值 —— 一改就是新内容、新 inode、重新付费。
 * `$0` 是被调用的那个路径(硬链接的名字),`.body` 与它同名同目录。
 */
const TRAMPOLINE_SOURCE = `#!/bin/bash
b="$0.body"
IFS= read -r first < "$b" || first=""
case "$first" in
  '#!'*)
    # 正文自带 shebang(比如从仓里原样复制过来的 .sh / .mjs):按它声明的解释器跑。
    # 这里的不加引号是**故意**的 —— "/usr/bin/env node" 要拆成两个词。
    exec \${first#'#!'} "$b" "$@"
    ;;
  *)
    exec /bin/bash "$b" "$@"
    ;;
esac
`

/** 桩正文落在可执行文件旁边,后缀由蹦床写死。 */
export const FIXTURE_BODY_SUFFIX = '.body'

/**
 * 在 `path` 放一个可执行桩,正文为 `body`(bash,无需 shebang)。返回 `path`。
 * 目录必须已存在 —— 调用方本来就在自己的临时目录里摆结构,这里不替它建。
 */
export function fixtureExecutable(path: string, body: string): string {
  writeFileSync(`${path}${FIXTURE_BODY_SUFFIX}`, body.endsWith('\n') ? body : `${body}\n`, {
    mode: 0o644,
  })

  const trampoline = cachedFixtureExecutable('gugu-fixture-trampoline', TRAMPOLINE_SOURCE)
  rmSync(path, { force: true })
  try {
    linkSync(trampoline, path)
    return path
  } catch {
    // 跨文件系统等情况下退回老做法:功能一样,只是要付一次首次执行费。
    writeFileSync(path, TRAMPOLINE_SOURCE, { mode: 0o755 })
    chmodSync(path, 0o755)
    return path
  }
}

/** 判断某个桩是不是走了蹦床(用于自检与测试)。 */
export function fixtureExecutableHasBody(path: string): boolean {
  return existsSync(`${path}${FIXTURE_BODY_SUFFIX}`)
}
