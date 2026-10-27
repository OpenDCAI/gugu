import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { AGENT_SEND_DATA_PART, toThreadMessages, type AgentSendData } from '@/mobile/agent-watch/thread-messages'

/**
 * 手机会话页:agent 经 message_send 说的话(群里派的任务,话都这么回)画成它说的话、标明发到哪,
 * ❌ 一张「调用了 MCP 工具」的卡;什么时候在折叠外面,与桌面同一份判断(turn-fold)。判据喂合成输入(形状取自真实记录)。
 */

type Item = TranscriptTurn['items'][number]
const CHAT = '127ec4f0-30b1-4583-b469-706756153bdd'
const input = (thread?: string) => ({
  kind: 'message', id: 'u1', seq: 0, role: 'user',
  text: renderDeliveryEnvelope({ route: 'chat', from: 'Owner', fromId: 'user:owner', chat: '216012', chatKind: 'group',
    sourceLink: `gugu-chat://${CHAT}/6417511d-8f36-4cbc-8cbb-81ce9f97df73`, messageId: 'msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73',
    content: '跑一轮', at: '2026-10-27T04:10:00Z', ...(thread ? { thread } : {}) }),
}) as Item
const bash = (id: string) => ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'sleep 10', command: 'sleep 10', status: 'done' }) as unknown as Item
const send = (id: string, text: string, status: 'running' | 'done' | 'error' = 'done') =>
  ({ kind: 'mcp-tool-call', id, seq: 0, toolCallId: id, title: 'message_send', server: 'gugu', tool: 'message_send', status,
    rawInput: JSON.stringify({ chat_id: '216012', text }), parentToolCallId: null }) as unknown as Item
const turn = (items: Item[], done = true) => ({ id: 't1', seq: 1, initiator: 'user', items, ...(done ? { outcome: { kind: 'done' } } : {}) }) as TranscriptTurn

const partsOf = (messages: ReturnType<typeof toThreadMessages>) =>
  messages.map((message) => (Array.isArray(message.content) ? message.content : []) as readonly { type: string; name?: string; data?: unknown; toolCallId?: string }[])
const sendsIn = (parts: readonly { type: string; name?: string; data?: unknown }[]) =>
  parts.filter((part) => part.type === 'data' && part.name === AGENT_SEND_DATA_PART).map((part) => part.data as AgentSendData)

describe('手机会话页:agent 经咕咕说的话', () => {
  it('跑着的时候每一轮的话都在命令之间,带着发到的话题;不收成一张 MCP 工具卡', () => {
    const messages = toThreadMessages([turn([input('msg:root'), bash('b1'), send('s1', '第 1 轮'), bash('b2'), send('s2', '第 2 轮', 'running')], false)], { liveTurnId: 't1' })
    const parts = partsOf(messages).flat()
    expect(sendsIn(parts).map((data) => [data.send.text, data.sending])).toEqual([['第 1 轮', false], ['第 2 轮', true]])
    expect(sendsIn(parts)[0]?.send.to).toEqual({ kind: 'chat', conversationId: CHAT, threadRootId: 'msg:root', whisper: false })
    expect(parts.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId)).toEqual(['b1', 'b2'])
  })

  it('跑完以后最后一句话留在折叠外面,前面的跟着过程折起来(同桌面)', () => {
    const messages = toThreadMessages([turn([input(), bash('b1'), send('s1', '第 1 轮'), bash('b2'), send('s2', '做完了')])])
    const last = partsOf(messages).at(-1)!
    expect(messages.at(-1)?.metadata).toBeUndefined()
    expect(sendsIn(last).map((data) => data.send.text)).toEqual(['做完了'])
    const process = messages.find((message) => message.metadata)!
    expect(sendsIn(partsOf([process])[0]!).map((data) => data.send.text)).toEqual(['第 1 轮'])
  })

  it('发失败的那一次照常是一张工具卡:失败的原因要看得见', () => {
    const parts = partsOf(toThreadMessages([turn([input(), send('s1', '没发出去', 'error')])])).flat()
    expect(sendsIn(parts)).toEqual([])
    expect(parts.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId)).toEqual(['s1'])
  })
})
