import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { mergeDeliveryEnvelopes, readDeliveryEnvelope, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { ChatMessage } from '@gugu/session-chat-ui'
import { dmRecord, dmRecordIds, mergeDmRecord } from '../../../../apps/desktop/src/components/chat/agent-dm-record'
import { contentWithQuote } from '../../../../apps/desktop/src/components/chat/messageQuoteContent'
import { composerCardLine } from '../../../../apps/desktop/src/lib/composerCardCopy'
import { withSentReplies } from '../../../../packages/session-chat-ui/src/state/sent-replies'
import { conversationMessages } from '../../../../packages/session-chat-ui/src/state/conversation-messages'
import { message } from '../../../support/testHarness'

const names = { me: { display_name: 'Ada' }, agent: { display_name: 'Agent' } }
const original = 'Alpha\n\nBeta\n\nGamma'
const answer = 'Answer only'
const actors = [{ label: 'mine', mine: true }, { label: 'peer', mine: false }]

function sourceAndReply(mine: boolean, content: string, sourceContent = original, sourceType: MessageItem['content_type'] = 'text') {
  const sender = mine ? 'me' : 'agent'
  const author = mine ? 'agent' : 'me'
  return [
    message({ id: 'source', seq: 1, chat_id: 'dm', sender_user_id: author, is_mine: !mine, content_type: sourceType, content: sourceContent }),
    message({ id: 'reply', seq: 2, chat_id: 'dm', sender_user_id: sender, is_mine: mine, content,
      reply_to_message_id: 'source', reply_to_sender_user_id: author, reply_to_content: sourceContent }),
  ]
}

/** Read the actual two presentation fields consumed by the shared transcript:
 * own deliveries use envelope body/preview; peer messages use text/conversationReply. */
function projection(messages: MessageItem[]) {
  const item = dmRecord(messages, names).at(-1)?.items[0]
  if (!item || item.kind !== 'message') throw new Error('Expected a projected reply message')
  return presentation(item)
}

function presentation(item: ChatMessage) {
  const envelope = item.guguDelivery ?? readDeliveryEnvelope(item.text)
  const reply = envelope?.segments[0]?.facts?.replyTo
  return {
    body: envelope?.body ?? item.text,
    quote: item.conversationReply?.text ?? reply?.preview,
    sourceId: reply?.messageId.replace(/^msg:/, '') ?? item.sentReplyTo,
  }
}

function recordedReply(rows: MessageItem[], mine: boolean): TranscriptTurn[] {
  const source = rows[0], reply = rows.at(-1)!
  const ownInput: TranscriptTurn['items'][number] = { kind: 'message', id: 'acp-input', seq: 11, role: 'user', text: renderDeliveryEnvelope({
    route: 'chat', from: 'Ada', fromId: 'user:me', fromType: 'human', messageId: `msg:${reply.id}`,
    chat: 'dm', chatKind: 'ai', at: reply.created_at, content: reply.content ?? '',
    ...(reply.reply_to_message_id ? { replyTo: { messageId: `msg:${source.id}`, fromId: `user:${source.sender_user_id}`, from: 'Agent', preview: source.content ?? '' } } : {}),
  }) }
  const call: TranscriptTurn['items'][number] = { kind: 'mcp-tool-call', id: 'send', toolCallId: 'send', seq: 12,
    title: 'Send', server: 'plugin_gugu-product_gugu', tool: 'message_send', status: 'done',
    rawInput: JSON.stringify({ chat_id: 'dm', text: reply.content, ...(reply.reply_to_message_id ? { reply_to_message_id: `msg:${source.id}` } : {}) }),
    outputText: JSON.stringify({ message_id: reply.id }), completedAt: 3000 }
  return [...dmRecord(rows.slice(0, -1), names).map((turn, i) => ({ ...turn, seq: 900 + i })),
    { id: 'existing-session', seq: 900 + rows.length - 1, initiator: mine ? 'user' : 'agent', items: [mine ? ownInput : call] }]
}

function paint(turns: readonly TranscriptTurn[]) {
  return conversationMessages(turns.map(turn => withSentReplies(turn, { allDestinations: true })))
}

function findReply(turns: readonly TranscriptTurn[], mine: boolean, replyId: string) {
  const id = mine ? 'acp-input' : `send:sent:${replyId}`
  const item = turns.flatMap(turn => turn.items).find(item => item.id === id)
  if (!item || item.kind !== 'message') throw new Error('Existing session reply was lost')
  return item
}

describe('agent DM received quote projection', () => {
  it.each(actors)('shows only the Beta excerpt once and only the answer in the $label body', ({ mine }) => {
    const senderName = mine ? 'Agent' : 'Ada'
    const content = contentWithQuote(answer, { messageId: 'source', senderName, content: 'Beta', originalContent: original })
    const shown = projection(sourceAndReply(mine, content))
    expect.soft(shown.quote).toBe('Beta')
    // Keeping the inline wire quote here would paint a second copy in Markdown.
    expect.soft(shown.body).toBe(answer)
    expect(shown.sourceId).toBe('source')
  })

  it.each(actors)('keeps the $label excerpt when an existing session turn wins the merge', ({ mine }) => {
    const senderName = mine ? 'Agent' : 'Ada'
    const content = contentWithQuote(answer, { messageId: 'source', senderName, content: 'Beta', originalContent: original })
    const rows = sourceAndReply(mine, content)
    const replyId = '6417511d-8f36-4cbc-8cbb-81ce9f97df75'
    rows[1] = { ...rows[1], id: replyId }
    const recorded = recordedReply(rows, mine)
    const before = JSON.stringify(recorded)
    const merged = mergeDmRecord(recorded, rows, names)
    const painted = paint(merged)
    const projectedId = mine ? 'acp-input' : `send:sent:${replyId}`
    const projected = painted.flatMap(turn => turn.items).find(item => item.id === projectedId)
    if (!projected || projected.kind !== 'message') throw new Error('Existing session reply was lost')
    expect.soft(presentation(projected).quote).toBe('Beta')
    expect.soft(presentation(projected).body).toBe(answer)
    expect(painted.flatMap(turn => turn.items).filter(item => item.id === projectedId)).toHaveLength(1)
    expect(dmRecordIds(merged).get(projectedId)).toEqual([replyId])
    expect(merged.map(turn => [turn.id, turn.seq])).toEqual([['im:source', 900], ['existing-session', 901]])
    expect(merged[1].items.find(item => item.id === (mine ? 'acp-input' : 'send'))).toMatchObject(recorded[1].items[0])
    const again = painted.map(turn => withSentReplies(turn, { allDestinations: true }))
    expect(again.flatMap(turn => turn.items).filter(item => item.id === projectedId)).toHaveLength(1)
    expect(JSON.stringify(recorded)).toBe(before)
  })

  it('projects only the selected segment in a batched delivery without changing receipt aliases or the raw envelope', () => {
    const content = contentWithQuote(answer, { messageId: 'source', senderName: 'Agent', content: 'Beta', originalContent: original })
    const rows = sourceAndReply(true, content)
    rows[1] = { ...rows[1], id: '6417511d-8f36-4cbc-8cbb-81ce9f97df78' }
    const recorded = recordedReply(rows, true)
    const input = recorded[1].items[0]
    if (input.kind !== 'message') throw new Error('Missing batched input')
    const next = message({ id: 'next', seq: 3, chat_id: 'dm', sender_user_id: 'me', is_mine: true, content: 'Next message' })
    const nextEnvelope = renderDeliveryEnvelope({ route: 'chat', from: 'Ada', fromId: 'user:me', fromType: 'human', messageId: 'msg:next', chat: 'dm', chatKind: 'ai', at: next.created_at, content: next.content! })
    recorded[1] = { ...recorded[1], items: [{ ...input, id: 'acp-batch', text: mergeDeliveryEnvelopes([input.text, nextEnvelope]) }] }
    const before = JSON.stringify(recorded)
    const merged = mergeDmRecord(recorded, [...rows, next], names)
    const item = merged[1].items[0] as ChatMessage
    const shown = item.guguDelivery ?? readDeliveryEnvelope(item.text)
    expect.soft(shown?.segments.map(segment => segment.body)).toEqual([answer, 'Next message'])
    expect.soft(shown?.segments[0].facts?.replyTo?.preview).toBe('Beta')
    expect(shown?.segments[1].facts?.replyTo).toBeNull()
    expect(item.text).toBe((recorded[1].items[0] as ChatMessage).text)
    const aliases = dmRecordIds(merged)
    expect(aliases.get('acp-batch')).toEqual([rows[1].id, 'next'])
    expect(aliases.get('acp-batch:batch-0')).toEqual([rows[1].id])
    expect(aliases.get('acp-batch:batch-1')).toEqual(['next'])
    expect(merged.map(turn => turn.seq)).toEqual([900, 901])
    expect(JSON.stringify(recorded)).toBe(before)
  })

  it('keeps successful text, file and text receipts in order and deduplicated while projecting an excerpt', () => {
    const ids = ['6417511d-8f36-4cbc-8cbb-81ce9f97df81', '6417511d-8f36-4cbc-8cbb-81ce9f97df82', '6417511d-8f36-4cbc-8cbb-81ce9f97df83']
    const content = contentWithQuote(answer, { messageId: 'source', senderName: 'Ada', content: 'Beta', originalContent: original })
    const rows = sourceAndReply(false, content)
    rows[1] = { ...rows[1], id: ids[0] }
    rows.push(message({ id: ids[1], seq: 3, chat_id: 'dm', sender_user_id: 'agent', is_mine: false,
      content_type: 'attachment', content: '[附件] proof.txt (text/plain)\n[Size] 9\n[Kind] file',
      file_item_id: '7417511d-8f36-4cbc-8cbb-81ce9f97df73', file_version: 2 }),
    message({ id: ids[2], seq: 4, chat_id: 'dm', sender_user_id: 'agent', is_mine: false, content: 'Last' }))
    const calls = ids.map((id, seq) => ({ kind: 'mcp-tool-call' as const, id: `call-${seq}`, toolCallId: `call-${seq}`, seq,
      title: 'Send', server: 'plugin_gugu-product_gugu', status: 'done' as const, tool: seq === 1 ? 'message_send_file' : 'message_send',
      rawInput: JSON.stringify(seq === 1 ? { chat_id: 'dm', file: 'existing-file' } : { chat_id: 'dm', text: seq === 0 ? content : 'Last', ...(seq === 0 ? { reply_to_message_id: 'msg:source' } : {}) }),
      outputText: JSON.stringify({ message_id: id }), completedAt: (seq + 1) * 1000 }))
    const recorded: TranscriptTurn[] = [{ ...dmRecord(rows.slice(0, 1), names)[0], seq: 900 }, { id: 'record', seq: 901, initiator: 'agent', items: calls }]
    const before = JSON.stringify(recorded)
    const merged = mergeDmRecord(recorded, rows, names)
    const outputs = paint(merged)[1].items.filter(item => item.kind === 'message') as ChatMessage[]
    expect(outputs.map(item => presentation(item).body)).toEqual([answer, 'proof.txt', 'Last'])
    expect(outputs[0].conversationReply?.text).toBe('Beta')
    expect(outputs[1].sentAttachment).toMatchObject({ messageId: ids[1], href: 'gugu-file://7417511d-8f36-4cbc-8cbb-81ce9f97df73?v=2' })
    expect(paint(paint(mergeDmRecord(merged, rows, names)))[1].items.filter(item => item.kind === 'message').map(item => item.id))
      .toEqual(ids.map((id, i) => `call-${i}:sent:${id}`))
    expect(dmRecordIds(merged).get(`call-1:sent:${ids[1]}`)).toEqual([ids[1]])
    expect(merged.map(turn => turn.seq)).toEqual([900, 901])
    for (const call of calls) expect(merged[1].items.find(item => item.id === call.id)).toEqual(call)
    expect(JSON.stringify(recorded)).toBe(before)
  })

  const cardBase = { v: 1 as const, text: 'Which plan?', deviceId: 'test-device', machineLabel: 'Test', sessionId: 'test-session', projectId: 'test-project' }
  const cards: ComposerCard[] = [
    { ...cardBase, type: 'task', agentUserId: 'agent', agentName: 'Agent' },
    { ...cardBase, type: 'schedule', automationId: 'schedule', scheduleLabel: 'Every day' },
    { ...cardBase, type: 'question', ownerUserId: 'me', questionId: 'question', options: ['A', 'B'] },
  ]
  for (const actor of actors) {
    it.each(cards)(`keeps a normal $type card reply unchanged in the ${actor.label} projection`, card => {
      const raw = serializeComposerCard(card)
      const rows = sourceAndReply(actor.mine, answer, raw, 'card')
      // A newer source from the same author keeps the ordinary older-target quote visible.
      rows.splice(1, 0, message({ id: 'newer', seq: 2, chat_id: 'dm', sender_user_id: rows[0].sender_user_id, is_mine: !actor.mine, content: 'Newer message' }))
      rows[2] = { ...rows[2], seq: 3 }
      expect(projection(rows)).toEqual({ body: answer, quote: raw, sourceId: 'source' })
      const source = dmRecord(rows, names)[0].items[0]
      expect(source.kind === 'message' && (readDeliveryEnvelope(source.text)?.body ?? source.text)).toBe(composerCardLine(raw))
      const received = { ...rows[2], id: '6417511d-8f36-4cbc-8cbb-81ce9f97df76' }
      rows[2] = received
      const recorded = recordedReply(rows, actor.mine)
      const before = paint(recorded)
      const after = paint(mergeDmRecord(recorded, rows, names))
      expect(presentation(findReply(after, actor.mine, received.id))).toEqual(presentation(findReply(before, actor.mine, received.id)))
    })
  }

  it.each(actors)('keeps an ordinary Markdown blockquote as the $label body without inventing a reply', ({ mine }) => {
    const content = '> A Markdown quotation\n\nAnswer below'
    const rows = sourceAndReply(mine, content)
    rows[1] = { ...rows[1], reply_to_message_id: null, reply_to_sender_user_id: null, reply_to_content: null }
    expect(projection(rows)).toEqual({ body: content, quote: undefined, sourceId: undefined })
    rows[1] = { ...rows[1], id: '6417511d-8f36-4cbc-8cbb-81ce9f97df77' }
    expect(presentation(findReply(paint(mergeDmRecord(recordedReply(rows, mine), rows, names)), mine, rows[1].id)))
      .toEqual({ body: content, quote: undefined, sourceId: undefined })
  })
})
