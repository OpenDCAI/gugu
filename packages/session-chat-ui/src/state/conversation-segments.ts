import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { hookSpeakerOfNotice } from '@gugu/session-core/acp';
import { toolCallName } from '@gugu/session-core/acp/client';
import { isQuestionOrPlanToolName } from '@gugu/session-core/session-record/question-tools';
import { parseHookNotice } from '@session-chat/lib/hook-notice';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { turnProcessId } from './turn-fold';

export type ConversationSegment = {
  kind: 'segment';
  id: string;
  items: ChatItem[];
  input?: ChatMessage;
  inputFrom?: 'background';
  startedAt?: number;
  endedAt?: number;
  live: boolean;
  idleMs: number;
};
export type ConversationBlock = { kind: 'input'; item: ChatItem } | ConversationSegment;

export function conversationSpoken(item: ChatItem): item is ChatMessage {
  return item.kind === 'message' && item.role === 'assistant' && !!item.text.trim()
    && !isGuguSilence(item.text) && !parseHookNotice(item.text);
}

/** Authentic event clocks only. Older provider replays deliberately have no wall clock. */
export function conversationEventAt(item: ChatItem): number | undefined {
  if ('at' in item && typeof item.at === 'number') return item.at;
  if (item.kind === 'compaction') return item.startedAt;
  return undefined;
}

function leaves(items: readonly ChatItem[]): ChatItem[] {
  return items.flatMap(item => item.kind === 'tool-group' ? leaves(item.children) : [item]);
}

/**
 * The replay prototype's render/closeSeg, before choosing any reply. Never split only
 * the process after choosing a turn-wide reply: that moves pre-steer words below the input.
 * Successful send projections are inserted next to their calls by withSentReplies.
 */
export function planConversationSegments(turn: TranscriptTurn, active: boolean): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let segment: ConversationSegment | undefined;
  let input: ChatMessage | undefined;
  let inputFrom: 'background' | undefined;
  let startedAt = turn.startedAt;
  let boundary: string | undefined;
  let hadSegment = false;
  let pendingInput = false;
  let previousAt: number | undefined;
  const open = (): ConversationSegment => {
    if (!segment) {
      segment = { kind: 'segment', id: boundary ? `${turnProcessId(turn.id)}@${boundary}` : turnProcessId(turn.id),
        items: [], live: false, idleMs: 0, ...(input ? { input } : {}), ...(inputFrom ? { inputFrom } : {}), ...(startedAt !== undefined ? { startedAt } : {}) };
      blocks.push(segment);
      hadSegment = true;
    }
    return segment;
  };
  const close = (at: number | undefined, id: string) => {
    // The boundary starts the next segment; it is not work performed by the old one.
    // Prototype render() measures a closed segment through its last agent event.
    segment = undefined;
    previousAt = undefined;
    startedAt = at;
    boundary = id;
  };
  for (const item of leaves(turn.items as readonly ChatItem[])) {
    if ('parentToolCallId' in item && item.parentToolCallId) continue;
    const at = conversationEventAt(item);
    if (item.kind === 'message' && item.role === 'user') {
      close(at ?? (!hadSegment ? turn.startedAt : undefined), item.id);
      if (!hadSegment) boundary = undefined;
      blocks.push({ kind: 'input', item });
      input = item;
      inputFrom = undefined;
      pendingInput = true;
      continue;
    }
    const notification = item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call';
    if (notification && segment?.items.some(conversationSpoken)) close(at, item.id);
    if (notification) {
      input = { kind: 'message', id: item.id, seq: item.seq, role: 'user', text: ('summary' in item ? item.summary : undefined) ?? item.title };
      inputFrom = 'background';
    }
    const question = 'toolCallId' in item && isQuestionOrPlanToolName(toolCallName(item));
    // Context and engine boundaries keep their chronological place outside process folds.
    if (question || item.kind === 'compaction' || item.kind === 'context-reset'
      || (item.kind === 'session-notice' && item.code !== 'provider-notice' && !hookSpeakerOfNotice(item))) {
      close(at, item.id);
      blocks.push({ kind: 'input', item });
      pendingInput = false;
      continue;
    }
    const current = open();
    if ((notification || item.kind === 'session-notice') && at !== undefined && previousAt !== undefined) current.idleMs += Math.max(0, at - previousAt);
    current.items.push(item);
    current.endedAt = 'completedAt' in item ? item.completedAt ?? at : at;
    previousAt = at;
    pendingInput = false;
    if (item.kind === 'message' && item.id.includes(':sent:')) close(at, item.id);
  }
  if (segment) {
    segment.live = active;
    // Message.at is the first streamed chunk; the turn's completion is the authentic final clock.
    if (!active && turn.endedAt !== undefined) segment.endedAt = turn.endedAt;
  } else if (active && pendingInput && blocks.at(-1)?.kind === 'input') {
    // A real steer has arrived, but no subsequent event yet: one process line, no empty body.
    open().live = true;
  }
  if (active && !blocks.length) open().live = true;
  return blocks;
}
