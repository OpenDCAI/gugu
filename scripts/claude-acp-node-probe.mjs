#!/usr/bin/env node
// @@@claude-acp-node-probe (#4394) — 证明「没装 node 的机器上 claude 通道能不能起来」。
//
// 为什么要有它:#4394 的故障只在**用户没装 node**时显形,而开发机、CI 机人人都有 node,
// 常规测试永远照不出。这里把那台机器造出来:把 PATH 清空,让 `resolveNodeInterpreter` 只剩
// 「Electron 自带的 node」这一条候选 —— 也就是产品为这类用户准备的兜底(#1181)。
//
// ❌ 不自己复现解析逻辑:探针调用的是**产品代码本身**(packages/session-plugins 的
// resolveNodeInterpreter + NODE_WITH_IMPORT_ATTRIBUTES),用的是仓里钉的那版 ACP adapter。
// 自己照着写一份再拿它验自己,是自证循环,证不了任何东西。
//
// ❗ 探针必须跑在**被测的 electron 里面**(ELECTRON_RUN_AS_NODE=1),因为候选里的
// 「electron 自带 node」取的就是 process.execPath。在外面用系统 node 跑,量到的是系统 node,
// 测的根本不是那台没装 node 的机器。
//
// 这个探针**证明什么、不证明什么**(别把它读宽了):
//   证明 —— 在 PATH 上没有任何 node 的机器上,产品能解析出一个够格的解释器,并用它把 ACP
//           adapter **加载起来、讲通 ACP**(走完 initialize)。#4394 的病灶正是加载期的
//           SyntaxError(import attributes 要 Node ≥20.10),所以这条断言打在点上。
//   不证明 —— claude 全链路可用。实测:CLAUDE_CODE_EXECUTABLE 指到不存在的路径,initialize
//           照样正常返回 —— adapter 到真开会话才 spawn claude。所以上面对 CLI 另做存在性
//           检查,不靠握手替它背书。
//
// 用法:
//   node scripts/claude-acp-node-probe.mjs                       # 用仓里当前的 electron
//   node scripts/claude-acp-node-probe.mjs <electronA> <electronB> ...   # 多版本 before/after 对照
//
// 退出码:所有被测 electron 都握手成功 → 0;有任何一个失败 → 1。

import { execFileSync } from 'node:child_process'
import {
  accessSync,
  constants as fsConstants,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(join(repoRoot, 'package.json'))

const INTERPRETER_SRC = join(
  repoRoot,
  'packages/session-plugins/src/agents/helpers/node-interpreter.ts',
)

function fail(message) {
  console.error(`[probe] ${message}`)
  process.exit(1)
}

// ── 被测的 electron 列表 ────────────────────────────────────────────────────────
let targets = process.argv.slice(2)
if (targets.length === 0) {
  try {
    targets = [require_('electron')] // electron 包的 index.js 导出二进制绝对路径
  } catch {
    fail('找不到 electron —— 装依赖后重试,或显式传入 electron 二进制路径')
  }
}

// ── claude CLI:产品把它经 CLAUDE_CODE_EXECUTABLE 交给 adapter ──────────────────
//
// ⚠️ 这里的存在性检查不是走过场。实测过:把 CLAUDE_CODE_EXECUTABLE 指到一个不存在的路径,
// ACP 的 `initialize` **照样正常返回 agentCapabilities** —— adapter 在这一步还没去 spawn
// claude,要到真开会话才碰它。也就是说「握手成功」不足以证明 claude 可用,不在这里把
// CLI 钉死,探针就会为错误的理由变绿(拿一个坏 CLI 也报通过)。
// ❌ 别只用 `sh -lc`:macOS 上 sh 读的是 .profile,而 claude 常装在 ~/.local/bin 且只由
// .zshrc 加进 PATH —— 探针会在真机上找不到它,然后**每一组对照都卡在同一个前置检查上**,
// 四条读数长得一模一样,看着像跑过了实则一条都没跑。所以按产品的做法(hydrateLoginShellPath
// 用的是 env.SHELL)优先问用户自己的登录 shell,再退到当前 PATH,最后才试常见安装位置。
function findClaudeCli() {
  if (process.env.PROBE_CLAUDE_CLI) return process.env.PROBE_CLAUDE_CLI
  const shell = process.env.SHELL?.trim()
  for (const attempt of [
    () => execFileSync(shell || '/bin/sh', ['-lic', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    () => execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    () => execFileSync('command', ['-v', 'claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  ]) {
    try {
      const found = attempt().trim().split('\n').filter(Boolean).pop()
      if (found && found.startsWith('/')) return found
    } catch {
      /* 试下一种 */
    }
  }
  for (const candidate of [
    join(process.env.HOME || '', '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      /* 试下一个 */
    }
  }
  return ''
}
const claudeCli = findClaudeCli()
if (!claudeCli) {
  fail('本机找不到 claude CLI。装一个(curl -fsSL https://claude.ai/install.sh | bash),或用 PROBE_CLAUDE_CLI 指过去')
}
try {
  accessSync(claudeCli, fsConstants.X_OK)
} catch {
  fail(`claude CLI 不可执行:${claudeCli}(探针拒绝在坏 CLI 上给出「通过」)`)
}

// ── 把产品的 node-interpreter 打成一个 electron 能直接 require 的 bundle ────────
const work = mkdtempSync(join(tmpdir(), 'gugu-acp-probe-'))
const interpreterBundle = join(work, 'node-interpreter.cjs')
try {
  execFileSync(
    join(repoRoot, 'node_modules/.bin/esbuild'),
    [
      INTERPRETER_SRC,
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${interpreterBundle}`,
      '--log-level=warning',
    ],
    { stdio: 'inherit' },
  )
} catch {
  rmSync(work, { recursive: true, force: true })
  fail(`打包产品的 node-interpreter 失败:${INTERPRETER_SRC}`)
}

// ── runner:在被测 electron 内部跑,产出一行 JSON 判词 ──────────────────────────
const runner = join(work, 'runner.cjs')
writeFileSync(
  runner,
  `
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const { resolveNodeInterpreter, NODE_WITH_IMPORT_ATTRIBUTES } = require(${JSON.stringify(interpreterBundle)})

const repoRoot = ${JSON.stringify(repoRoot)}
const claudeCli = ${JSON.stringify(claudeCli)}
const req = createRequire(require('node:path').join(repoRoot, 'package.json'))

function out(verdict) {
  process.stdout.write('@@PROBE@@' + JSON.stringify(verdict) + '\\n')
  process.exit(0)
}

// 这台机器「没装 node」= PATH 上一个 node 都没有。GUGU_NODE_BIN 也不给,
// 否则测的是显式覆盖那条路,不是兜底那条。
//
// PROBE_KEEP_PATH=1 是**阳性对照**:保留真实 PATH 再跑一遍。老 electron 在这个模式下应该转绿
// (它会从 PATH 上挑到系统 node)。跑通它才能说「老版本是**因为没 node** 才断的」——
// 否则一个恒失败的探针也能给出同样好看的 before/after。
const env = process.env.PROBE_KEEP_PATH === '1' ? { PATH: process.env.PATH || '' } : { PATH: '' }

let resolved
try {
  resolved = resolveNodeInterpreter({
    env,
    require: NODE_WITH_IMPORT_ATTRIBUTES,
    purpose: 'claude 的 ACP adapter',
  })
} catch (error) {
  out({
    hostElectron: process.versions.electron || null,
    hostNode: process.versions.node,
    step: 'resolve',
    ok: false,
    error: String(error && error.message || error),
  })
}

let acpEntry
try {
  acpEntry = req.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js')
} catch (error) {
  out({ hostElectron: process.versions.electron || null, hostNode: process.versions.node,
        step: 'acp-entry', ok: false, error: String(error && error.message || error) })
}

// 解析出解释器还不够 —— 真把 adapter 起起来握一次手才算数。
const child = spawn(resolved.command, [acpEntry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: claudeCli },
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => { stdout += d })
child.stderr.on('data', (d) => { stderr += d })

const done = (extra) => out({
  hostElectron: process.versions.electron || null,
  hostNode: process.versions.node,
  step: 'handshake',
  interpreter: { source: resolved.source, version: resolved.version, command: resolved.command },
  ...extra,
})

// 握手等的是 agentCapabilities 或 adapter 退出,二者必居其一;不计时(#4357)。
// adapter 活着却永不作答时,探针停在这里 —— 外层那行 step=probe <bin> 指着它。

child.on('error', (error) => {
  done({ ok: false, error: String(error && error.message || error) })
})

child.stdout.on('data', () => {
  if (!stdout.includes('agentCapabilities')) return
  child.kill('SIGKILL')
  done({ ok: true })
})

child.on('exit', (code) => {
  if (stdout.includes('agentCapabilities')) return done({ ok: true })
  done({ ok: false, error: 'adapter 退出(code ' + code + ')未回 agentCapabilities',
         stderrHead: stderr.split('\\n').filter(Boolean).slice(0, 3).join(' / ') })
})

child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
}) + '\\n')
`,
  'utf8',
)

// ── 逐个跑 ─────────────────────────────────────────────────────────────────────
console.log(`claude CLI : ${claudeCli}`)
console.log(
  process.env.PROBE_KEEP_PATH === '1'
    ? `PATH       : (保留真实 PATH —— 阳性对照,老 electron 在这里应该转绿)\n`
    : `PATH       : (探针内清空 —— 模拟一台从没装过 node 的机器)\n`,
)

const results = []
for (const bin of targets) {
  let raw = ''
  try {
    process.stderr.write(`[claude-acp-node-probe] step=probe ${bin}\n`)
    raw = execFileSync(bin, [runner], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    raw = String(error.stdout || '')
    if (!raw.includes('@@PROBE@@')) {
      results.push({ bin, ok: false, error: `探针自身没跑起来:${String(error.message).split('\n')[0]}` })
      continue
    }
  }
  const line = raw.split('\n').find((l) => l.startsWith('@@PROBE@@'))
  if (!line) {
    results.push({ bin, ok: false, error: '探针没产出判词' })
    continue
  }
  results.push({ bin, ...JSON.parse(line.slice('@@PROBE@@'.length)) })
}

rmSync(work, { recursive: true, force: true })

// ── 报告 ───────────────────────────────────────────────────────────────────────
let allOk = true
for (const r of results) {
  const tag = r.ok ? '✅ 通' : '❌ 断'
  if (!r.ok) allOk = false
  const host = r.hostElectron ? `electron ${r.hostElectron} (内置 node ${r.hostNode})` : r.bin
  console.log(`${tag}  ${host}`)
  if (r.interpreter) {
    console.log(`      选中解释器: ${r.interpreter.source} = ${r.interpreter.version}`)
  }
  if (!r.ok) {
    console.log(`      卡在: ${r.step ?? '?'}`)
    console.log(`      原因: ${String(r.error).split('\n').join('\n            ')}`)
    if (r.stderrHead) console.log(`      stderr: ${r.stderrHead}`)
  }
  console.log()
}

console.log(allOk ? '全部通过。' : '存在未通过项。')
process.exit(allOk ? 0 : 1)
