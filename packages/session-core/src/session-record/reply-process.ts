import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { isGuguServer } from '../acp/models/turns/opened-outputs';
import type { McpToolCall, ToolCallItem } from '../acp/models/turns/tool-calls';
import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';

export type ReplyProcess = { thinkingMs: number; thoughts: number; tools: number; commands: number };

export function replyItems(turn: TranscriptTurn): TranscriptItem[] {
  const expand = (item: TranscriptItem): TranscriptItem[] => item.kind === 'tool-group' ? item.children.flatMap(expand) : [item];
  return turn.items.flatMap(expand);
}

export function replySource(turn: TranscriptTurn, options: { includeThreads?: boolean } = {}): DeliveryReadFacts | null {
  const input = turn.items.filter(item => item.kind === 'message' && item.role === 'user').at(-1);
  if (input?.kind !== 'message') return null;
  const envelope = readDeliveryEnvelope(input.text);
  const facts = envelope?.segments.length === 1 ? envelope.segments[0]?.facts : null;
  return facts?.route === 'chat' && facts.messageId && facts.chat && (options.includeThreads || !facts.thread) && !facts.whisperTo ? facts : null;
}

function sourceChatMatches(facts: DeliveryReadFacts, chatId: unknown): boolean {
  if (chatId === facts.chat) return true;
  const source = facts.sourceLink ? parseConversationLink(facts.sourceLink) : null;
  return source?.messageId !== undefined && source.messageId === facts.messageId?.replace(/^msg:/, '').toLowerCase()
    && source.chatId === chatId;
}

function isRootSend(item: ToolCallItem): item is McpToolCall {
  return item.kind === 'mcp-tool-call' && item.tool === 'message_send' && isGuguServer(item.server) && !item.parentToolCallId;
}

/** Only the explicit send to this input's destination can preview an IM reply. */
export function replySend(item: ToolCallItem, facts: DeliveryReadFacts): { text: string; replyToMessageId?: string } | null {
  if (!isRootSend(item) || !item.rawInput) return null;
  try {
    const args = JSON.parse(item.rawInput) as Record<string, unknown>;
    if (!sourceChatMatches(facts, args.chat_id) || typeof args.text !== 'string' || args.whisper === true) return null;
    if (args.reply_to_message_id !== undefined && (typeof args.reply_to_message_id !== 'string'
      || args.reply_to_message_id.replace(/^msg:/, '') !== facts.messageId?.replace(/^msg:/, ''))) return null;
    return { text: args.text, ...(typeof args.reply_to_message_id === 'string' ? { replyToMessageId: args.reply_to_message_id.replace(/^msg:/, '') } : {}) };
  } catch { return null; }
}

/** Actual successful sends owned by this agent, including proactive sends to another chat. */
export function successfulMessageSend(item: ToolCallItem): { text: string; id: string } | null {
  if (!isRootSend(item) || item.status !== 'done' || !item.rawInput) return null;
  const id = sentMessageId(item);
  if (!id) return null;
  try {
    const args = JSON.parse(item.rawInput) as Record<string, unknown>;
    return typeof args.chat_id === 'string' && args.chat_id && typeof args.text === 'string'
      ? { id, text: args.text } : null;
  } catch { return null; }
}

/** Root work only; nested subagent rows must not inflate the primary's counts. */
export function replyProcess(turn: TranscriptTurn, before?: string): ReplyProcess {
  const result: ReplyProcess = { thinkingMs: 0, thoughts: 0, tools: 0, commands: 0 };
  const items = replyItems(turn);
  const inputId = items.filter(item => item.kind === 'message' && item.role === 'user').at(-1)?.id;
  let afterInput = inputId === undefined;
  for (const item of items) {
    if (item.id === inputId) { afterInput = true; continue; }
    if (!afterInput) continue;
    if (item.id === before) break;
    if (item.kind === 'thinking') {
      result.thoughts += 1;
      if (item.durationMs !== undefined) result.thinkingMs += Math.max(0, item.durationMs);
    } else if ('toolCallId' in item && !item.parentToolCallId
      && !(item.kind === 'mcp-tool-call' && isGuguServer(item.server) && item.tool === 'message_send')) {
      result.tools += 1;
      if (item.kind === 'execute-tool-call') result.commands += 1;
    }
  }
  return result;
}

export function sentMessageId(item: McpToolCall): string | null {
  const parse = (raw: unknown): string | null => {
    if (typeof raw === 'string') {
      const sent = /^(?:sent|replied) \(id=(?:msg:)?([a-f0-9-]{36})\)$/.exec(raw);
      if (sent) return sent[1]!;
      try { return parse(JSON.parse(raw)); } catch { return null; }
    }
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    if (typeof value.message_id === 'string') return value.message_id;
    if (Array.isArray(value.content)) {
      for (const block of value.content) {
        if (block?.type === 'text') { const id = parse(block.text); if (id) return id; }
      }
    }
    return null;
  };
  return parse(item.rawOutput) ?? parse(item.outputText);
}

export function replyProcesses(turns: readonly TranscriptTurn[], chatId: string): ReadonlyMap<string, ReplyProcess> {
  const results = new Map<string, ReplyProcess>();
  for (const turn of turns) {
    const facts = replySource(turn);
    if (!facts || !sourceChatMatches(facts, chatId)) continue;
    for (const item of replyItems(turn)) {
      // The successful result names the canonical DB message, which the private-chat renderer matches by id.
      // Do not parse transport-trimmed rawInput to recover that attribution: a long text can cut its JSON.
      if (!('toolCallId' in item) || !isRootSend(item) || item.status !== 'done') continue;
      const id = sentMessageId(item);
      if (id) results.set(id, replyProcess(turn, item.id));
    }
  }
  return results;
}
