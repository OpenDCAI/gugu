#!/usr/bin/env node
// 引擎可用性 preflight —— 在测量【之前】沿被测系统实际解析它的那条路问一次。
//
// 为什么不能用 `command -v` / `existsSync`:同一条判据**两个方向都会骗人**。
//   假阴  `command -v codex` 在非登录 shell 里红,而 codex 一直在        (仓内已记)
//   假阳  `command -v codex` 绿(它是 JS shim 的符号链接),而本体不在      (2026-08-13 实测:
//         `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex` 是个**空目录**)
// ⚠️ 假阳比假阴坏得多:假阴让你白等,假阳让你带着一个不存在的引擎去跑,
//    然后把它起不来的失败**读成产品行为** —— 而"agent 一次工具都没调"恰好是
//    owner 第 4 条的极端好成绩,于是那个失败会伪装成一条漂亮读数。
//
// ⇒ 唯一可靠的问法:真 spawn 它、真等 exit、真读 stderr。
// ⇒ 这个检查属于**仪器**不属于 runbook:写进 runbook 的下一个人一样会漏。
//
//   node scripts/agent-engine-preflight.mjs claude=/abs/path/claude codex=/abs/path/codex
//
// ⚠️ `--version` 只答「二进制在、能启动、能回答」,答不了「引擎能不能工作」——
// 2026-08-13 mac1 实测:claude --version ⇒ OK 2.1.229,而真跑一轮 ⇒ `Not logged in`。
// 若只信 --version 的绿:每轮 agent 都因未认证不调工具 ⇒ B=0 且 allPosts>=2
// ⇒ 旧判决规则读成「产品读数:agent 选择了不调工具」⇒ **一整组假读数,
// 方向恰好是 owner 第 4 条的满分**。⇒ 所以要第四态,判据是【真跑一轮】。
//
// ⚠️ 且这条探针必须跑在【产品的 env】里:裸 shell 的「未登录」说的是**我的环境**,
// 不是引擎状态(mac1 实测:产品要转发的 ANTHROPIC_* 键在我这条 SSH 登录 shell 里全缺)。
//
// 四种终止态,各有自己的名字(❌ 不合并):
//   OK       退出 0        引擎在,能回答
//   DEAD     error/非 0    引擎不在或起不来        ⇒ 换机器
//   TIMEOUT  永不返回      引擎起来了但不回答      ⇒ 多半是 TTY,修法完全不同
//   UNAUTH   真跑一轮被拒  二进制没问题,引擎不能工作 ⇒ 补认证,❌ 不是"换机器"
// ⚠️ 把 TIMEOUT 归进 DEAD 就是把「没回答」当成「不存在」—— 与「rc≠0 有两种:判据说不合格 /
// 判据根本没跑」同形,只是发生在**等待**这一侧。而只接 error+close【连挂住都发现不了】:
// 探针会无限等下去,于是整条测量在开跑前静默停住,「还没结束」与「结束了但没留标记」同形。
//
// rc=0 全部 OK;rc=1 有 DEAD;rc=3 有 TIMEOUT;rc=4 有 UNAUTH。原话打在 stderr,❌ 不摘要、❌ 不兜底。
//
// PREFLIGHT_TURN=1 时改用【真跑一轮】判据(各引擎的调用形状是实测出来的,见 TURN_SHAPES)。
const TURN_MODE = process.env.PREFLIGHT_TURN === '1'
// 2026-08-13 mac1 实测:codex 不加 --skip-git-repo-check 会红在 "Not inside a trusted directory";
// 且它会从 stdin 读输入 ⇒ 必须给 /dev/null,否则挂住(那会被记成 TIMEOUT,而真因是 stdin)。
const TURN_SHAPES = {
  claude: ['-p', 'reply with the single word OK', '--max-turns', '1'],
  codex: ['exec', '--skip-git-repo-check', 'reply with the single word OK'],
}
// ⚠️ UNAUTH 的主语是【本 rig 这次调用】,❌ 不是「这台机器的引擎不可用」。
// 2026-08-13 查明(产生者 0d848760,我转述未自跑):claude 的认证是产品**每会话自己铸**的——
// resolveAgentModelLaunch → issuePlatformModelAccess 铸中转票,经 _meta.claudeCode.options.env
// 与一份 0600 的 --settings 文档注入;它**不来自**登录 shell、不来自 ~/.claude/.credentials.json。
// ⇒ 所以在产品的铸票之外裸跑,claude 必然 UNAUTH,而同一台机器上产品自己跑得动。
// ⇒ 该状态可作「rig 现在能不能跑一轮」的闸,❌ 不可作「引擎在这台机器上不可用」的结论。
// ⚠️ 且中转票是【按模型签的】:只搬 env 不搬 settings 文档 ⇒ 403 no access to model …,
// 那个 403 长得像认证问题,真因是模型没钉 ⇒ 两者必须一起搬。
/** 未认证的原话签名(实测)。⚠️ 认不出的不归此桶 —— 宁可记 DEAD 也不猜。 */
const UNAUTH_MARKERS = ['Not logged in', 'Please run /login', 'invalid_api_key', 'Invalid API key']

import { spawn } from 'node:child_process'

// ⚠️ 这个超时【可以调大】,它不属于"调大超时=删判据"那一类。区分:
//   装置容忍度  「我愿意等 --version 多久」   ⇒ 调大不削弱任何断言   ⇒ 本行属于这类,可调
//   判据观测预算「等 X 出现 N 秒才算没有」    ⇒ 调大改变结论含义     ⇒ 不可调
// ⇒ 共享机器(mac1)有负载,冷启可能超默认值。撞到 TIMEOUT 时**先调大重试一次**,
//   再判「引擎不回答」—— 否则会把一次负载慢读成认证失败,而两者修法完全不同。
const TIMEOUT_MS = Number(process.env.PREFLIGHT_TIMEOUT_MS ?? 20000)

/** ⚠️ 必须是绝对路径:shell alias(本机 `claude` = `reclaude`)在 spawn 里不存在。 */
function probe(name, binary) {
  return new Promise((resolve) => {
    // detached:让它自成进程组。⚠️ 实测:被测二进制常是 shell wrapper,SIGKILL 只杀掉 wrapper,
    // 它 spawn 的孙进程会**活下来** —— 在共享机器上就是我留给下一个人的孤儿。
    const args = TURN_MODE ? (TURN_SHAPES[name] ?? ['--version']) : ['--version']
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    // 第三种终止态:既不 error 也不 close。杀掉它 —— ❌ 不留孤儿进程给下一个人。
    const timer = setTimeout(() => {
      // 杀【进程组】(-pid),不是杀 pid。组不存在时 kill 会抛,兜住它但不吞掉状态。
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      finish({ name, binary, state: 'TIMEOUT', detail: `no answer in ${TIMEOUT_MS}ms (auth prompt? TTY?)` })
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    // spawn 失败(ENOENT)只走 'error',不走 'close' ⇒ 两条都要接,否则会静默挂住。
    child.on('error', (error) => finish({ name, binary, state: 'DEAD', detail: String(error.message) }))
    child.on('close', (code) => finish(
      code === 0
        ? { name, binary, state: 'OK', detail: stdout.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '' }
        : UNAUTH_MARKERS.some((m) => (stdout + stderr).includes(m))
          ? { name, binary, state: 'UNAUTH', detail: (stderr || stdout).trim().split('\n').filter(Boolean)[0] ?? '' }
          : { name, binary, state: 'DEAD', detail: `exit=${code} ${(stderr || stdout).trim().split('\n')[0]}` },
    ))
  })
}

const specs = process.argv.slice(2).map((argument) => {
  const at = argument.indexOf('=')
  if (at < 1) {
    console.error(`usage: agent-engine-preflight.mjs <engine>=<absolute-binary-path> ...  (got: ${argument})`)
    process.exit(2)
  }
  return { name: argument.slice(0, at), binary: argument.slice(at + 1) }
})
if (specs.length === 0) {
  console.error('usage: agent-engine-preflight.mjs <engine>=<absolute-binary-path> ...')
  process.exit(2)
}

const results = await Promise.all(specs.map((spec) => probe(spec.name, spec.binary)))
for (const result of results) {
  console.log(`${result.state.padEnd(7)} ${result.name} ${result.binary} :: ${result.detail}`)
}
// fail loud,且**两种不可用分开报**:调用方据此放弃该臂并如实记原因,❌ 不进入测量 ——
// 一个起不来/不回答的引擎产出的读数会与产品行为同形。
const dead = results.filter((result) => result.state === 'DEAD')
const stuck = results.filter((result) => result.state === 'TIMEOUT')
const unauth = results.filter((result) => result.state === 'UNAUTH')
if (unauth.length > 0) console.error(`engine preflight UNAUTH (binary fine, engine cannot work): ${unauth.map((r) => r.name).join(', ')}`)
if (stuck.length > 0) console.error(`engine preflight TIMEOUT (present but unresponsive): ${stuck.map((r) => r.name).join(', ')}`)
if (dead.length > 0) console.error(`engine preflight DEAD (missing or unlaunchable): ${dead.map((r) => r.name).join(', ')}`)
if (dead.length > 0) process.exit(1)
if (stuck.length > 0) process.exit(3)
if (unauth.length > 0) process.exit(4)
