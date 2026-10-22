import { describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { TURN_RETURN_DATA_PART, toThreadMessages } from '@/mobile/agent-watch/thread-messages'

/**
 * 手机会话页的「已回到 X」(gugu-dev#181):从群里来的一轮、真往那个群发过,这一轮底下挂一行(同桌面);没发过就没有。
 * 判据喂合成输入(信封与工具调用的形状取自真实记录)。
 */

type Item = TranscriptTurn['items'][number]
const CHAT = '127ec4f0-30b1-4583-b469-706756153bdd'
const SOURCE = 'ee1a78d8-55f3-42ac-b437-4cf4e81a4741'
const SENT = '6417511d-8f36-4cbc-8cbb-81ce9f97df73'
const input = {
  kind: 'message', id: 'u1', seq: 0, role: 'user',
  text: `<gugu_delivery route="chat" from="Owner" from_id="user:owner" msg="msg:${SOURCE}" chat="213036" chat_kind="group" source_link="gugu-chat://${CHAT}/${SOURCE}"><![CDATA[介绍一下你自己]]></gugu_delivery>`,
} as Item
const send = (chatId: string) => ({
  kind: 'mcp-tool-call', id: 's1', seq: 1, toolCallId: 's1', title: 'message_send', server: 'gugu', tool: 'message_send', status: 'done',
  rawInput: JSON.stringify({ chat_id: chatId, text: '我是 Codex' }), outputText: `sent (id=msg:${SENT})`,
}) as unknown as Item
const turn = (items: Item[]) => ({ id: 't1', seq: 1, initiator: 'user', items, outcome: { kind: 'done' } }) as TranscriptTurn
const returnParts = (messages: ReturnType<typeof toThreadMessages>) => messages.flatMap((message) =>
  (Array.isArray(message.content) ? message.content : []).filter((part) => typeof part === 'object' && part.type === 'data' && part.name === TURN_RETURN_DATA_PART))

describe('手机:这一轮的结果回到了哪个群', () => {
  it('真往来的那个群发过:挂一行,带群和发进去的那条消息', () => {
    expect(returnParts(toThreadMessages([turn([input, send('213036')])])))
      .toEqual([{ type: 'data', name: TURN_RETURN_DATA_PART, data: { turnId: 't1', chatId: CHAT, messageId: SENT } }])
  })
  it('没往那个群发过:没有这一行', () => {
    expect(returnParts(toThreadMessages([turn([input, send('other')])]))).toEqual([])
    expect(returnParts(toThreadMessages([turn([input])]))).toEqual([])
  })
})
