import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { hookSpeakerOfNotice } from '@gugu/session-core/acp';
import { toolCallName } from '@gugu/session-core/acp/client';
import { isQuestionOrPlanToolName } from '@gugu/session-core/session-record/question-tools';
import { processHookNotice } from '@session-chat/lib/hook-notice';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { turnProcessId } from './turn-fold';

export type ConversationSegment = {
  kind: 'segment';
  id: string;
  items: ChatItem[];
  startedAt?: number;
  endedAt?: number;
  live: boolean;
  idleMs: number;
  fullReply?: true;
};
export type ConversationBlock = { kind: 'input'; item: ChatItem } | ConversationSegment;

export function conversationSpoken(item: ChatItem): item is ChatMessage {
  return item.kind === 'message' && item.role === 'assistant' && !!item.text.trim()
    && !isGuguSilence(item.text) && !processHookNotice(item);
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
  let startedAt = turn.startedAt;
  let boundary: string | undefined;
  let hadSegment = false;
  let pendingInput = false;
  let previousAt: number | undefined;
  let pendingStop: { owner: ConversationSegment; items: ChatItem[] } | undefined;
  const open = (): ConversationSegment => {
    if (!segment) {
      segment = { kind: 'segment', id: boundary ? `${turnProcessId(turn.id)}@${boundary}` : turnProcessId(turn.id),
        items: [], live: false, idleMs: 0, ...(startedAt !== undefined ? { startedAt } : {}) };
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
  const finishStop = (continueAt?: number, split = false) => {
    if (!pendingStop) return;
    const { owner, items } = pendingStop;
    pendingStop = undefined;
    if (split && owner.items.length) {
      close(conversationEventAt(items[0]) ?? continueAt, items[0].id);
      open().items.push(...items);
    } else {
      owner.items.push(...items);
      segment = owner;
    }
  };
  for (const item of leaves(turn.items as readonly ChatItem[])) {
    if ('parentToolCallId' in item && item.parentToolCallId) continue;
    const at = conversationEventAt(item);
    const hook = processHookNotice(item);
    if (hook?.hookName === 'Stop') {
      // A send may have closed before its silence marker. At this Stop boundary
      // the marker belongs to that sent reply, not to a new empty Stop owner.
      const beforeSilence = blocks.at(-2);
      if (segment?.items.length && segment.items.every(part => part.kind === 'message' && part.role === 'assistant'
        && (!part.text.trim() || isGuguSilence(part.text))) && beforeSilence?.kind === 'segment'
        && beforeSilence.items.some(part => part.kind === 'message' && part.id.includes(':sent:'))) {
        beforeSilence.items.push(...segment.items);
        blocks.pop();
        segment = beforeSilence;
      }
      const previous = blocks.at(-1);
      const owner = pendingStop?.owner ?? segment ?? (previous?.kind === 'segment' && !pendingInput ? previous : open());
      if (owner.items.some(conversationSpoken)) owner.fullReply = true;
      if (pendingStop) pendingStop.items.push(item);
      else pendingStop = { owner, items: [item] };
      continue;
    }
    const activity = item.kind === 'thinking' || conversationSpoken(item) || ('toolCallId' in item
      && item.kind !== 'subagent-done-tool-call' && item.kind !== 'background-command-done-tool-call');
    const boundaryItem = (item.kind === 'message' && item.role === 'user') || item.kind === 'compaction' || item.kind === 'context-reset'
      || item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call';
    if (pendingStop && !activity && !boundaryItem) { pendingStop.items.push(item); continue; }
    finishStop(at, activity);
    if (item.kind === 'message' && item.role === 'user') {
      close(at ?? (!hadSegment ? turn.startedAt : undefined), item.id);
      if (!hadSegment) boundary = undefined;
      blocks.push({ kind: 'input', item });
      pendingInput = true;
      continue;
    }
    const notification = item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call';
    if (notification) {
      // Completion is its own observed event, never an inferred reply target.
      close(at, item.id);
      blocks.push({ kind: 'input', item });
      pendingInput = true;
      continue;
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
    if (item.kind === 'session-notice' && at !== undefined && previousAt !== undefined) current.idleMs += Math.max(0, at - previousAt);
    current.items.push(item);
    current.endedAt = 'completedAt' in item ? item.completedAt ?? at : at;
    previousAt = at;
    pendingInput = false;
    if (item.kind === 'message' && item.id.includes(':sent:')) close(at, item.id);
  }
  finishStop();
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
