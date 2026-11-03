import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { isSelfSender, timelineRailMessages, timelineRailPreviewText, type TimelineRailOptions } from '@gugu/core/shared/timelineRail';
import { shownSender, type SelfIdentity, type TranscriptTurn } from '@gugu/session-chat-ui';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';

/** Delivery provenance for previews, independent of whether the turn is the viewer's own. */
export type TimelineSender =
  | { kind: 'chat'; name: string }
  /** `chatId` 从来源链接里取(信封的 chat 是群号,给 agent 寻址用);名字由画的那一层按它去认。 */
  | { kind: 'group'; name: string; chatId: string | null }
  | { kind: 'session'; name: string }
  /** #6387 An installed extension, relaying what the person did in it. */
  | { kind: 'extension'; name: string }
  /** Someone in a forum post this agent was assigned to. */
  | { kind: 'forum'; name: string }
  /** 咕咕 itself (a `system` notice), or a legacy / batched envelope that names nobody. */
  | { kind: 'gugu' };

/** One navigable input and the first reply before the next input. */
export interface TimelineTurn {
  id: string;
  /** Additional inputs can share a provider turn with the first input. */
  sourceTurnId?: string;
  /** Item to scroll to on click — the turn's first item, i.e. the prompt. */
  anchorItemId: string;
  /** Every item id of the turn: the rail maps the row under the reading line back to its turn by these. */
  itemIds: string[];
  prompt: string;
  reply: string;
  mine: boolean;
  /** Group deliveries retain their source, including the signed-in person's messages. */
  sender?: TimelineSender;
}

function senderOf(facts: DeliveryReadFacts, self: SelfIdentity | null): TimelineSender {
  // #5048 the signed-in user's own delivered turn is named from the local profile, like the card.
  const name = shownSender(facts.from, facts.fromId, self);
  if (!name) return { kind: 'gugu' };
  if (facts.route === 'session-direct') return { kind: 'session', name };
  if (facts.route === 'extension') return { kind: 'extension', name };
  if (facts.route === 'forum') return { kind: 'forum', name };
  if (facts.chatKind === 'group') return { kind: 'group', name, chatId: (facts.sourceLink && parseConversationLink(facts.sourceLink)?.chatId) || null };
  return { kind: 'chat', name };
}

/**
 * Provider turns can contain several user inputs (steer / chat deliveries).
 * Each input owns only the items up to the next input, so preview, reading
 * marker and jump all refer to the same message. Callers supply both history
 * and the active snapshot; completion is not a prerequisite for navigation.
 */
export function timelineTurnsFromTranscript(
  transcript: readonly TranscriptTurn[],
  self: SelfIdentity | null = null,
  options: TimelineRailOptions = {},
): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  for (const turn of transcript) {
    let current: TimelineTurn | undefined;
    let first = true;
    for (const item of turn.items) {
      if (item.kind === 'message' && item.role === 'user') {
        // Every input ends the preceding preview, including a hidden delivery.
        current = undefined;
        const firstInput = first;
        first = false;
        const delivery = readDeliveryEnvelope(item.text);
        if (turn.initiator !== 'user' && !delivery) continue;
        const humans = timelineRailMessages(item.text, { ...options, selfUserId: self?.userId ?? options.selfUserId });
        for (const [index, human] of humans.entries()) {
          const isFirst = firstInput && index === 0;
          current = {
            id: isFirst ? turn.id : `${turn.id}:${item.id}${index ? `:${index}` : ''}`,
            ...(isFirst ? {} : { sourceTurnId: turn.id }),
            anchorItemId: item.id,
            itemIds: [item.id],
            prompt: human.text,
            reply: '',
            mine: human.sender === null || isSelfSender(human.sender, self?.userId ?? options.selfUserId),
            ...(human.sender ? { sender: senderOf(human.sender, self) } : {}),
          };
          turns.push(current);
        }
        // A reply to a mixed batch cannot be attributed to any one human.
        if (delivery && delivery.segments.length !== humans.length) current = undefined;
        continue;
      }
      if (!current) continue;
      current.itemIds.push(item.id);
      if (!current.reply && item.kind === 'message' && item.role === 'assistant') {
        current.reply = timelineRailPreviewText(item.text);
      }
    }
  }
  return turns;
}

/**
 * 画在轨道上的一格。轮数超过轨道站得下的格数时一格代表多轮(见 `turnsPerTick`),
 * 于是「一格 = 一轮」不再恒成立,`from`/`to` 说清它到底代表哪几轮(1 基,闭区间)。
 */
export interface TimelineTick {
  /** The first own turn in a mixed tick, otherwise the first turn. */
  turn: TimelineTurn;
  from: number;
  to: number;
  /** Any own input keeps the whole tick emphasized and provides its jump target. */
  mine: boolean;
}

/** 按「一格 n 轮」把轮次切成格子:每一轮都归属某一格,❌ 没有一轮被丢在格子之外。 */
export function ticksFromTurns(
  turns: readonly TimelineTurn[],
  turnsPerTick: number
): TimelineTick[] {
  const stride = Math.max(1, Math.floor(turnsPerTick));
  const ticks: TimelineTick[] = [];
  for (let start = 0; start < turns.length; start += stride) {
    const group = turns.slice(start, start + stride);
    const own = group.find((turn) => turn.mine);
    ticks.push({
      turn: own ?? group[0],
      from: start + 1,
      to: start + group.length,
      mine: own !== undefined,
    });
  }
  return ticks;
}
