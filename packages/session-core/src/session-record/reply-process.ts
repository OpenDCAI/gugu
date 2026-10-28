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

export function replySource(turn: TranscriptTurn, batchOwnerId?: string, options: { includeThreads?: boolean } = {}): DeliveryReadFacts | null {
  const input = turn.items.filter(item => item.kind === 'message' && item.role === 'user').at(-1);
  if (input?.kind !== 'message') return null;
  return replySourceText(input.text, batchOwnerId, options);
}

function replySourceText(text: string, batchOwnerId?: string, options: { includeThreads?: boolean } = {}): DeliveryReadFacts | null {
  const envelope = readDeliveryEnvelope(text);
  const segments = envelope?.segments ?? [];
  const sameOwnerBatch = batchOwnerId && segments.every(segment => segment.facts?.route === 'chat'
    && segment.facts.fromId === `user:${batchOwnerId}` && segment.facts.chat === segments[0]?.facts?.chat
    && !segment.facts.thread && !segment.facts.whisperTo);
  const facts = segments.length === 1 || sameOwnerBatch ? segments.at(-1)?.facts : null;
  return facts?.route === 'chat' && facts.messageId && facts.chat && (options.includeThreads || !facts.thread) && !facts.whisperTo ? facts : null;
}

function sourceChatMatches(facts: DeliveryReadFacts, chatId: unknown): boolean {
  if (chatId === facts.chat) return true;
  const source = facts.sourceLink ? parseConversationLink(facts.sourceLink) : null;
  return source?.messageId !== undefined && source.messageId === facts.messageId?.replace(/^msg:/, '').toLowerCase()
    && source.chatId === chatId;
}

function isRootGuguTool(item: ToolCallItem, tool: string): item is McpToolCall {
  return item.kind === 'mcp-tool-call' && item.tool === tool && isGuguServer(item.server) && !item.parentToolCallId;
}

function isRootSend(item: ToolCallItem): item is McpToolCall {
  return isRootGuguTool(item, 'message_send');
}

/** Where an agent's own send went, as the session timeline names it. */
export type AgentSendTarget =
  | {
      kind: 'chat';
      /** The conversation the person can name (host `chatName`); null when the agent addressed it by number only. */
      conversationId: string | null;
      /** The thread this session is bound to: a send to the delivery's own chat lands there (the server, not the agent, picks it). */
      threadRootId: string | null;
      whisper: boolean;
    }
  | { kind: 'session'; count: number };

export type AgentSend = { text: string; to: AgentSendTarget };

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The delivery that the agent was answering when it made this call: the last input before it in the turn. */
function inputFactsBefore(turn: TranscriptTurn, item: TranscriptItem): DeliveryReadFacts | null {
  const items = replyItems(turn);
  const end = items.indexOf(item);
  const input = items.slice(0, end < 0 ? items.length : end).findLast((it) => it.kind === 'message' && it.role === 'user');
  if (input?.kind !== 'message') return null;
  const facts = readDeliveryEnvelope(input.text)?.segments.at(-1)?.facts;
  return facts?.route === 'chat' ? facts : null;
}

/**
 * What the agent said through 咕咕 instead of in its own reply: a top-level `message_send` / `session_message` with its
 * text. The session timeline shows it as the agent speaking, with where it went (desktop flatten and the phone's
 * thread-messages read this one function, like `openedOutputOf`). A failed call, a subagent's, or one whose input was
 * cut in transport (no parsable text) stays an ordinary tool row: its reason or its args are what there is to read.
 * Without `turn` it only answers "is this a send" (tool-run and turn-fold do not need the destination).
 */
export function agentSendOf(item: TranscriptItem, turn?: TranscriptTurn): AgentSend | null {
  if (!('toolCallId' in item) || item.status === 'error') return null;
  const relay = isRootGuguTool(item, 'session_message');
  if (!relay && !isRootSend(item)) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(item.rawInput ?? '') as Record<string, unknown>;
  } catch { return null; }
  if (!args || typeof args.text !== 'string' || !args.text.trim()) return null;
  if (relay) return { text: args.text, to: { kind: 'session', count: Array.isArray(args.to) ? args.to.length : 0 } };
  const whisper = args.whisper === true;
  const facts = turn ? inputFactsBefore(turn, item) : null;
  const here = facts !== null && sourceChatMatches(facts, args.chat_id);
  const linked = here && facts.sourceLink ? parseConversationLink(facts.sourceLink)?.chatId ?? null : null;
  const conversationId = linked ?? (typeof args.chat_id === 'string' && CONVERSATION_ID.test(args.chat_id) ? args.chat_id.toLowerCase() : null);
  return { text: args.text, to: { kind: 'chat', conversationId, threadRootId: here && !whisper ? facts.thread : null, whisper } };
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
    if (value.isError === true) return null;
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

/** A real top-level Gugu send receipt, shared by chat projections and durable work reconciliation. */
export function successfulGuguSendMessageId(item: ToolCallItem): string | null {
  if (item.kind !== 'mcp-tool-call' || !isGuguServer(item.server) || item.parentToolCallId || item.status !== 'done'
    || !/(?:^|__)message_send(?:_file)?$/.test(item.tool)) return null;
  return sentMessageId(item);
}

/** A confirmed reply to the owner's current input, never an agent's claim that it replied. */
export function canYieldRepliedAssistant(turn: TranscriptTurn | null, nextText: string, ownerId: string): boolean {
  if (!turn) return false;
  const previous = replySource(turn, ownerId);
  const next = replySourceText(nextText, ownerId);
  if (!previous || !next || previous.fromId !== `user:${ownerId}` || next.fromId !== `user:${ownerId}`
    || !(sourceChatMatches(previous, next.chat) || sourceChatMatches(next, previous.chat))) return false;
  // A receipt from before a later steered input does not mean that later input has a reply.
  const items = replyItems(turn);
  const inputIndex = items.findLastIndex(item => item.kind === 'message' && item.role === 'user');
  const lastTool = items.slice(inputIndex + 1).findLast(item => 'toolCallId' in item);
  // An acknowledgement followed by real work is not a model-only trailing response.
  return !!lastTool && 'toolCallId' in lastTool && isRootSend(lastTool)
    && lastTool.status === 'done' && replySend(lastTool, previous) !== null && sentMessageId(lastTool) !== null;
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

/**
 * The turns of an agent's session that belong to one chat with it (the agent DM shows its session record through the
 * task page's transcript, only this conversation): a turn is kept when one of its inputs was delivered from that chat,
 * or when the agent sent a message to that chat in it (a scheduled turn that reports back). A prompt typed on the task
 * page carries no delivery and stays out, and so does a turn that only answered another chat.
 */
export function filterTurnsForChat(turns: readonly TranscriptTurn[], chatId: string): TranscriptTurn[] {
  return turns.filter((turn) => replyItems(turn).some((item) => {
    if (item.kind === 'message' && item.role === 'user') {
      return (readDeliveryEnvelope(item.text)?.segments ?? []).some(
        (segment) => segment.facts?.route === 'chat' && sourceChatMatches(segment.facts, chatId),
      );
    }
    if (!('toolCallId' in item) || !successfulMessageSend(item) || !item.rawInput) return false;
    try {
      return (JSON.parse(item.rawInput) as { chat_id?: unknown }).chat_id === chatId;
    } catch { return false; }
  }));
}
