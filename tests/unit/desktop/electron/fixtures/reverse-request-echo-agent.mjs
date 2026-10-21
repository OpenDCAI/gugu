#!/usr/bin/env node
// #2545 — 最小假 ACP agent:initialize → session/new → 收到 session/prompt 后，先对 host 发起两个反向
// session/request_permission 请求（一个 UUID 字符串 id，一个数字 id），把 host 回包里的 id 原样报回来，
// 再结束回合。用于 tests/unit/desktop/electron/acpHostReverseIdEcho.test.ts：不依赖任何真实 agent CLI
// 的运行时行为（是否真的会发反向请求、走不走 fs/* 代理都因引擎/配置而异，见 #2545 的协议探针结论），
// 直接构造历史事故（PR #1999）复现的确切形状：id 若被 Number() 强转，UUID 字符串会变 NaN → JSON
// 序列化成 null，agent 侧就再也匹配不到应答。
import { createInterface } from 'node:readline'

const STRING_ID = 'a1b2c3d4-e5f6-47a8-89bc-0123456789ab'
const NUMBER_ID = 424242
const REQUEST_TIMEOUT_MS = 5000

const pending = new Map()

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reverseRequest(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ id: '__TIMEOUT__', timedOut: true })
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { options: [] } })
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

  // 我们自己发的反向请求的响应（有 id、有 result/error、没有 method）。
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
  if (msg.method === 'initialized') return // 通知，无需回包
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fixture-session-1' } })
    return
  }
  if (msg.method === 'session/prompt') {
    void (async () => {
      const stringResp = await reverseRequest(STRING_ID)
      const numberResp = await reverseRequest(NUMBER_ID)
      const report = {
        stringSent: STRING_ID,
        stringReceived: stringResp.id,
        stringType: typeof stringResp.id,
        numberSent: NUMBER_ID,
        numberReceived: numberResp.id,
        numberType: typeof numberResp.id,
      }
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'fixture-session-1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(report) } },
        },
      })
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    })()
    return
  }
})
