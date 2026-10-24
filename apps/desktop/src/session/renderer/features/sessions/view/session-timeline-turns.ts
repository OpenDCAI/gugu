import { readDeliveryEnvelope, type DeliveryReading } from '@gugu/core/local/agent/deliveryEnvelope';
import { shownSender, type SelfIdentity, type TranscriptTurn } from '@gugu/session-chat-ui';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';

/**
 * Who a delivered turn came from. The rail paints these ticks differently from
 * the user's own turns and names the sender in the preview (#4874, owner
 * 2026-09-04:「别人发过来的消息…要看出来消息来自于谁」— identical ticks made
 * the two indistinguishable).
 */
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
  /** Absent for the user's own turns. */
  sender?: TimelineSender;
}

function senderOf(delivery: DeliveryReading, self: SelfIdentity | null): TimelineSender {
  const facts = delivery.segments.length === 1 ? delivery.segments[0]!.facts : null;
  // #5048 the signed-in user's own delivered turn is named from the local profile, like the card.
  const name = facts ? shownSender(facts.from, facts.fromId, self) : null;
  if (!facts || !name || facts.route === 'system' || facts.route === 'scheduled') return { kind: 'gugu' };
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
  self: SelfIdentity | null = null
): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  for (const turn of transcript) {
    let current: TimelineTurn | undefined;
    let first = true;
    for (const item of turn.items) {
      if (item.kind === 'message' && item.role === 'user') {
        const delivery = readDeliveryEnvelope(item.text);
        const prompt = (delivery?.body ?? item.text).trim();
        // Agent-only synthetic user rows are not user inputs. An actual
        // delivery remains navigable even when it arrives in an agent turn.
        if (!prompt || (turn.initiator !== 'user' && !delivery)) continue;
        current = {
          id: first ? turn.id : `${turn.id}:${item.id}`,
          ...(first ? {} : { sourceTurnId: turn.id }),
          anchorItemId: item.id,
          itemIds: [],
          prompt,
          reply: '',
          ...(delivery ? { sender: senderOf(delivery, self) } : {}),
        };
        first = false;
        turns.push(current);
      }
      if (!current) continue;
      current.itemIds.push(item.id);
      if (!current.reply && item.kind === 'message' && item.role === 'assistant') {
        current.reply = item.text.trim();
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
  /** 代表这一格的那一轮:格子里有投递就取第一条投递,否则取头一轮。 */
  turn: TimelineTurn;
  from: number;
  to: number;
  /**
   * 这一格里有没有别人发来的。tone 认它而不是 `turn.sender` —— 否则一条投递被埋在
   * 格子中间就整格看不出来,而「要看出来消息来自于谁」是 owner 2026-09-04 定的。
   * 取第一条投递当代表,正是为了让 tone 与预览卡上的名字对得上。
   */
  delivered: boolean;
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
    const delivered = group.find((turn) => turn.sender !== undefined);
    ticks.push({
      turn: delivered ?? group[0],
      from: start + 1,
      to: start + group.length,
      delivered: delivered !== undefined,
    });
  }
  return ticks;
}
