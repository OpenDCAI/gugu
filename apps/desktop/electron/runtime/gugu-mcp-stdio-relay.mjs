#!/usr/bin/env node

// 咕咕 MCP 的 stdio ⇄ streamable-HTTP 中继(#6335 Antigravity 终端腿)。
//
// ## 为什么要它
//
// Antigravity 两条腿共用咕咕托管的**一份** `.gemini`(owner 原则:一个 harness 一个配置根,❌ 每会话一份)。
// 终端腿 `agy` 的 MCP 只有一个载体 —— 那份根里的全局 `config/mcp_config.json`,而咕咕 MCP 的地址与令牌
// 是**每会话**的。把它们写进那份文件 = 并发的两条终端会话互相覆盖令牌,聊天面板腿的 `agy_acp_server`
// 也会读到同一份、拿别人的令牌连上去。
// ⇒ 文件里只写**与会话无关**的一条:`command` = 本中继(随咕咕发的程序,路径是应用级事实)。
//   地址与令牌只在终端腿的 spawn 环境里(`GUGU_SESSION_MCP_URL_<后缀>` / `GUGU_SESSION_MCP_BEARER_<后缀>`,
//   与 codex 那条腿同一套命名),`agy` 起 stdio server 时子进程继承它的环境,中继从那里读。
//
// ## 形态
//
// 透明转发:stdin/stdout 上的每条 JSON-RPC 原样发给上游、上游的每条原样写回。
// SDK 没有现成的 proxy(@modelcontextprotocol/sdk 1.29.0 文档只给 Transport 接口:start/send/close/onmessage),
// 所以直接把两个 Transport 的 onmessage 对接起来:
//   · 下游 `StdioServerTransport`(本进程 stdin/stdout);
//   · 上游 `StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization } } })`
//     —— 会话 id(`mcp-session-id`)与 initialized 之后的独立 SSE 流由它自己管;协议版本头要在看到
//     initialize 的应答时手动 `setProtocolVersion`(平时是 `Client.connect` 替它做,这里没有 Client)。
//
// ## 静默退化(⚠️ 必须)
//
// 聊天面板腿的服务读的是**同一份** `mcp_config.json`,它起本中继时环境里没有这两个变量。那时本中继
// 不连任何上游,只在本地答:initialize → 空能力、tools/list → 空表、ping → {},其余请求回「方法不存在」,
// 通知一律吞掉。❌ 不退出、❌ 不报错 —— 起不来的 MCP server 会被那边记成「MCP server failed to initialize」,
// 而咕咕的 turnFailure 把那句话当成回合失败。上游在会话中途断了(咕咕重启、授权被收回)同样只回错误、不退出。

import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const SERVER_INFO = { name: 'gugu-mcp-stdio-relay', version: '1' }

/** 与 codex 那条腿(`mcpSuffix`)、capability-bundle 的环境变量后缀同一个归一。 */
export function relayEnvSuffix(name) {
  return String(name).replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
}

export function relayTarget(name, env = process.env) {
  const suffix = relayEnvSuffix(name)
  const url = env[`GUGU_SESSION_MCP_URL_${suffix}`]?.trim()
  const bearer = env[`GUGU_SESSION_MCP_BEARER_${suffix}`]?.trim()
  return url ? { url, bearer: bearer || null } : null
}

function isRequest(message) {
  return message && typeof message === 'object' && 'method' in message && 'id' in message
}

/** 没有上游时的本地应答 —— 一台「在、但没有工具」的 server。 */
export function offlineResponse(message) {
  if (!isRequest(message)) return null
  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      }
    case 'tools/list':
      return { jsonrpc: '2.0', id: message.id, result: { tools: [] } }
    case 'ping':
      return { jsonrpc: '2.0', id: message.id, result: {} }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not available in this session` } }
  }
}

async function main() {
  const name = process.argv[2]?.trim() || 'gugu'
  const target = relayTarget(name)
  const downstream = new StdioServerTransport()

  if (!target) {
    downstream.onmessage = (message) => {
      const reply = offlineResponse(message)
      if (reply) void downstream.send(reply)
    }
    await downstream.start()
    return
  }

  const upstream = new StreamableHTTPClientTransport(new URL(target.url), {
    requestInit: target.bearer ? { headers: { Authorization: `Bearer ${target.bearer}` } } : {},
  })
  const initializeIds = new Set()
  // 起上游只起一次:stdin 上的几条消息可能在第一次 start() 还没回来时就到了 —— 各自再 start 会抛
  // 「already started」。所有转发共用这一个 promise,也就按到达顺序排好了。
  let upstreamReady = null

  upstream.onmessage = (message) => {
    // initialize 的应答里带着协商出的协议版本 —— 之后每个请求都要带 `mcp-protocol-version` 头。
    if (message && 'id' in message && initializeIds.has(message.id)) {
      initializeIds.delete(message.id)
      const version = message.result?.protocolVersion
      if (typeof version === 'string') upstream.setProtocolVersion(version)
    }
    void downstream.send(message)
  }
  upstream.onerror = (error) => {
    process.stderr.write(`[gugu-mcp-stdio-relay] upstream: ${error?.message ?? error}\n`)
  }

  downstream.onmessage = async (message) => {
    if (isRequest(message) && message.method === 'initialize') initializeIds.add(message.id)
    try {
      upstreamReady ??= upstream.start()
      await upstreamReady
      await upstream.send(message)
    } catch (error) {
      process.stderr.write(`[gugu-mcp-stdio-relay] forward ${message?.method ?? 'response'}: ${error?.message ?? error}\n`)
      if (isRequest(message)) {
        void downstream.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: `gugu MCP is not reachable: ${error?.message ?? error}` },
        })
      }
    }
  }
  downstream.onclose = () => {
    void upstream.close().finally(() => process.exit(0))
  }
  await downstream.start()
}

// 被 import(单测)时不跑;被当成程序起时才连 stdin/stdout。
// ⚠️ 用 pathToFileURL + realpath 比:打包路径带空格与中文(`/Applications/咕咕 Beta.app/…`),手拼 `file://` 比不上。
function invokedAsProgram() {
  if (!process.argv[1]) return false
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return false
  }
}
if (invokedAsProgram()) {
  main().catch((error) => {
    process.stderr.write(`[gugu-mcp-stdio-relay] ${error?.stack ?? error}\n`)
    process.exit(1)
  })
}
