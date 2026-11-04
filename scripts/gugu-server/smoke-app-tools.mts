#!/usr/bin/env node
// 出包冒烟的一项(ci-linux-packages.sh 在干净的 Ubuntu 里跑):包里每个预装 App 的每个程序,照咕咕起程序的样子起一次,
// 问一次 tools/list。只问清单、不调工具:回了 tools 数组就算过(没配 key 的程序回什么都算),起不来、报错、
// 30 秒不回就失败,并打出程序自己在 stderr 上说的最后几行。
//
// 起法照抄产品,只有 launchOf 这一份;单测拿每个预装 App 真实的 manifest,逐项和产品比(tests/unit/scripts/
// smokeAppToolsLaunch7131.test.ts),产品改了这里没跟就红:
//   · extension-session-mcp.ts 的 extensionAgentPrograms —— tools 模块 = `gugu-tools.mjs <模块>`;command "node" = 咕咕自己的
//     node,参数里指向包内文件的换成绝对路径;两种都在咕咕的 node 上跑,env 带 manifest 的 env、ELECTRON_RUN_AS_NODE=1 与 GUGU_EXTENSION_*。
//   · extension-programs.ts 的 OwnedStdioTransport —— 在咕咕的 node 上跑的程序先 `--import gugu-program.mjs`,第四个 stdio 槽是
//     IPC(advanced 序列化);stdin / stdout 是它的 MCP,一行一条 JSON-RPC。
// 不在咕咕的 node 上跑的程序(npx、uvx……)这里不起:干净的服务器上本来就没有它们,打一行「跳过」。
//
// 用法:<包>/node/bin/node smoke-app-tools.mts <包目录>
import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** One program of an App as gugu starts it; null for one not on gugu's node. */
export interface SmokeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  serialization: 'advanced'
  detached: true
}

type SmokeServer =
  | { tools: string; env?: Readonly<Record<string, string>> }
  | { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }

interface SmokeRuntime {
  node: string
  programRuntime: string
  toolsRuntime: string
  dataDir: string
  linkPrefix: string
  settings?: Record<string, string | boolean>
}

interface JsonRpcMessage {
  id?: number
  error?: unknown
  result?: { tools?: { name: string }[] }
}

/**
 * How gugu starts one program of an App: its executable, arguments, env (what gugu sets — the rest is the process's own),
 * cwd and stdio. null for a program not on gugu's node (npx, uvx…). `node` is gugu's node, `programRuntime` /
 * `toolsRuntime` the App runtime's gugu-program.mjs / gugu-tools.mjs, `linkPrefix` this build's `<scheme>://ext`.
 */
export function launchOf(
  appId: string,
  root: string,
  server: SmokeServer,
  { node, programRuntime, toolsRuntime, dataDir, linkPrefix, settings = {} }: SmokeRuntime,
): SmokeLaunch | null {
  let args: string[]
  if ('tools' in server) args = [toolsRuntime, join(root, server.tools)]
  else if (server.command === 'node') {
    args = (server.args ?? []).map((arg) => (arg.startsWith('-') || isAbsolute(arg) || !existsSync(join(root, arg)) ? arg : join(root, arg)))
  } else return null
  return {
    command: node,
    args: ['--import', pathToFileURL(programRuntime).href, ...args],
    env: {
      ...(server.env ?? {}),
      GUGU_EXTENSION_ID: appId,
      GUGU_EXTENSION_DATA_DIR: dataDir,
      GUGU_EXTENSION_LINK_BASE: `${linkPrefix}/${appId}`,
      GUGU_APP_SETTINGS: JSON.stringify(settings),
      ELECTRON_RUN_AS_NODE: '1',
    },
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    detached: true,
  }
}

const fail = (message: string): void => {
  console.error(`::error::${message}`)
  process.exitCode = 1
}

/** One program, started as launchOf says; resolves with its tool names, rejects with what went wrong. */
function toolsOf({ command, args, env, ...options }: SmokeLaunch): Promise<string[]> {
  return new Promise((done, failed) => {
    const child = spawn(command, args, { ...(options as SpawnOptions), env: { ...process.env, ...env } })
    let stderr = ''
    let pending = ''
    const replies = new Map<number, (message: JsonRpcMessage) => void>()
    const end = (error: string | null, names: string[] = []) => {
      clearTimeout(timer)
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {}
      if (error) failed(new Error(`${error}${stderr.trim() ? `\n  stderr: ${stderr.trim().split('\n').slice(-5).join('\n  stderr: ')}` : ''}`))
      else done(names)
    }
    const timer = setTimeout(() => end('30 秒没有回 tools/list'), 30_000)
    child.on('error', (error) => end(`起不来:${error.message}`))
    child.on('exit', (code, signal) => end(`还没回 tools/list 就退出了(code ${code}, signal ${signal})`))
    child.stderr!.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    child.stdout!.on('data', (chunk) => {
      pending += chunk
      for (let at = pending.indexOf('\n'); at !== -1; at = pending.indexOf('\n')) {
        const line = pending.slice(0, at).trim()
        pending = pending.slice(at + 1)
        if (!line) continue
        let message: JsonRpcMessage
        try {
          message = JSON.parse(line)
        } catch {
          return end(`stdout 上不是 JSON-RPC:${line.slice(0, 200)}`)
        }
        if (message.id !== undefined && replies.has(message.id)) replies.get(message.id)!(message)
      }
    })
    const ask = (id: number, method: string, params: unknown) =>
      new Promise<JsonRpcMessage>((answered) => {
        replies.set(id, answered)
        child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    ;(async () => {
      const hello = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gugu-server-smoke', version: '1' } })
      if (hello.error) return end(`initialize 报错:${JSON.stringify(hello.error)}`)
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const listed = await ask(2, 'tools/list', {})
      if (listed.error) return end(`tools/list 报错:${JSON.stringify(listed.error)}`)
      if (!Array.isArray(listed.result?.tools)) return end(`tools/list 回的不是 tools 数组:${JSON.stringify(listed.result).slice(0, 200)}`)
      end(null, listed.result.tools.map((tool) => tool.name))
    })()
  })
}

/** Every program of every preinstalled App in the package at `pkg`: started once, asked tools/list. */
async function smoke(pkg: string): Promise<void> {
  const appDir = join(pkg, 'app')
  const runtimeRoot = join(appDir, 'dist-electron', 'app-runtime')
  const runtimeVersions = existsSync(runtimeRoot)
    ? readdirSync(runtimeRoot).filter((name) => existsSync(join(runtimeRoot, name, 'gugu-program.mjs')))
    : []
  if (runtimeVersions.length !== 1) {
    return fail(`包里的 App 运行时不是恰好一份:${runtimeRoot} 下有 gugu-program.mjs 的目录 ${runtimeVersions.length} 个`)
  }
  const runtime = {
    node: process.execPath,
    programRuntime: join(runtimeRoot, runtimeVersions[0], 'gugu-program.mjs'),
    toolsRuntime: join(runtimeRoot, runtimeVersions[0], 'gugu-tools.mjs'),
    linkPrefix: 'gugu://ext',
  }
  const appsDir = join(appDir, 'apps', 'desktop', 'preinstalled-apps')
  const apps = existsSync(appsDir)
    ? readdirSync(appsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(appsDir, entry.name, 'manifest.json')))
        .map((entry) => entry.name)
    : []
  if (apps.length === 0) return fail(`包里没有预装 App:${appsDir}`)

  for (const appId of apps) {
    const root = join(appsDir, appId)
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
    const servers: (SmokeServer & { name?: string; command?: string })[] = manifest.contributes?.mcpServers ?? []
    if (servers.length === 0) console.log(`${appId}: 没有程序`)
    for (const server of servers) {
      const name = `${appId}/${server.name ?? appId}`
      const launch = launchOf(appId, root, server, { ...runtime, dataDir: mkdtempSync(join(tmpdir(), `smoke-${appId}-`)) })
      if (!launch) {
        console.log(`${name}: 跳过(command ${server.command} 不在咕咕的 node 上跑)`)
        continue
      }
      try {
        const names = await toolsOf(launch)
        console.log(`${name}: tools/list ${names.length} 个${names.length ? `(${names.join(', ')})` : ''}`)
      } catch (error) {
        fail(`${name}: ${(error as Error).message}`)
      }
    }
  }
}

// Imported by the unit test for launchOf alone; run as a script, it smokes a package. Node runs the script at its real path
// (/tmp on macOS is /private/tmp), so the two are compared as real paths — a miss here would be a silent green.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await smoke(resolve(process.argv[2] ?? ''))
