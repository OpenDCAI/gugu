#!/usr/bin/env node
// #3366 — 最小假 ACP agent：把 host 在 `session/new` 里请求的 permission mode 原样报回来，并模拟
// claude-agent-acp 在非 bypass 模式下必走的那次反向 `session/request_permission`，把 host 的应答一并报回。
//
// 为什么要在 wire 上观测而不是读常量：本票的丢失分支由 **agent 侧看到的 currentModeId** 选中
// （claude-agent-acp `canUseTool` 里 `currentModeId === 'bypassPermissions'` 时本地放行、不发反向请求，
// 于是 adapter 之后不再产生任何 tool event，MCP host 收不到执行请求 ⇒ 会话永远 pending-tool-call）。
// 断言"我们送出去的那个字节"才能在回归时判假；断言源码常量只是把常量抄了两遍。
import { createInterface } from 'node:readline'

const PERMISSION_REQUEST_ID = 'c0ffee00-1111-4222-8333-444455556666'
const REQUEST_TIMEOUT_MS = 5000

// 与 claude-agent-acp 在 default 模式下真实提供的选项同形（allow_always / allow_once / reject_once）。
const PERMISSION_OPTIONS = [
  { kind: 'allow_always', name: 'Always allow', optionId: 'allow_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
]

let observedSessionNewParams = null
const pending = new Map()

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reverseRequest(id, method, params) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ timedOut: true })
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
    const resolver = pending.get(msg.id)
    if (resolver) {
      pending.delete(msg.id)
      resolver(msg)
    }
    return
  }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { agentCapabilities: { loadSession: false } } })
    return
  }
  if (msg.method === 'initialized') return
  if (msg.method === 'session/new') {
    observedSessionNewParams = msg.params ?? null
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'permission-mode-probe-1' } })
    return
  }
  if (msg.method === 'session/prompt') {
    void (async () => {
      const permissionResponse = await reverseRequest(
        PERMISSION_REQUEST_ID,
        'session/request_permission',
        { sessionId: 'permission-mode-probe-1', options: PERMISSION_OPTIONS }
      )
      const report = {
        requestedPermissionMode: observedSessionNewParams?.permissions?.defaultMode ?? null,
        permissionOutcome: permissionResponse?.result?.outcome?.outcome ?? null,
        permissionOptionId: permissionResponse?.result?.outcome?.optionId ?? null,
        permissionTimedOut: permissionResponse?.timedOut === true,
      }
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'permission-mode-probe-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: JSON.stringify(report) },
          },
        },
      })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    })()
    return
  }
})
