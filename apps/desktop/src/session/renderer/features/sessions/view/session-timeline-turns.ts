import { readDeliveryEnvelope, type DeliveryReading } from '@gugu/core/local/agent/deliveryEnvelope';
import { isSelfAddress, shownSender, type SelfIdentity, type TranscriptTurn } from '@gugu/session-chat-ui';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { turnsPerTick } from './session-timeline-geometry';

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
  /** A delivery the signed-in user sent themselves (in a group / chat to this agent): on the rail it is still「你说的」. */
  fromSelf?: true;
}

/** 轨道上算「你说的」:直接打进来的一轮,或你自己从聊天里发给它的投递(owner 2026-10-28「一眼找到我说过的话」)。 */
export const isOwnTurn = (turn: TimelineTurn) => turn.sender === undefined || turn.fromSelf === true;

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

function fromSelf(delivery: DeliveryReading, self: SelfIdentity | null): boolean {
  const facts = delivery.segments.length === 1 ? delivery.segments[0]!.facts : null;
  return !!facts && isSelfAddress(facts.fromId, self);
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
          ...(delivery && fromSelf(delivery, self) ? { fromSelf: true as const } : {}),
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
 * 连续这么多条不是你发的输入(投递)合并成轨道上的一格(owner 2026-10-28:「灰色线多了以后要合并」)。
 * 1–2 条是正常的一来一回(agent 回一句、别的会话转来一句),照旧一条一格;3 条起才是一串刷屏。
 */
export const DELIVERY_RUN_MIN = 3;

/**
 * 画在轨道上的一格。它先按「你的一轮 / 一条投递 / 连续 ≥ DELIVERY_RUN_MIN 条投递合成的一段」切,
 * 段数还超过轨道站得下的格数时再一格代表多段(见 `turnsPerTick`),于是「一格 = 一轮」不再恒成立,
 * `from`/`to` 说清它到底代表哪几轮(1 基,闭区间)。
 */
export interface TimelineTick {
  /** 代表这一格的那一轮:格子里有你的一轮就取你的头一轮(owner 10-28「有你的就按你的画」),否则取头一轮。点击跳到它。 */
  turn: TimelineTurn;
  from: number;
  to: number;
  /** 这一格里有没有你自己的一轮 —— 有就按「你的」画,❌ 被同格的投递盖掉。 */
  mine: boolean;
  /** 这一格里有几条投递(别人发来的;你自己从聊天发来的算你的,见 `isOwnTurn`)。 */
  deliveries: number;
  /** 投递的发送者(去重,按出现先后),预览卡写「N 条投递 · 来自 …」。 */
  senders: TimelineSender[];
}

/** 你的一轮(见 `isOwnTurn`)各成一段;连续的投递够 DELIVERY_RUN_MIN 条合成一段,不够就一条一段。返回每段的 [from, to](0 基,闭区间)。 */
function segmentsOf(turns: readonly TimelineTurn[]): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  for (let i = 0; i < turns.length; ) {
    if (isOwnTurn(turns[i]!)) {
      segments.push([i, i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < turns.length && !isOwnTurn(turns[end + 1]!)) end += 1;
    if (end - i + 1 >= DELIVERY_RUN_MIN) segments.push([i, end]);
    else for (let k = i; k <= end; k += 1) segments.push([k, k]);
    i = end + 1;
  }
  return segments;
}

const senderKey = (sender: TimelineSender) => (sender.kind === 'gugu' ? 'gugu' : `${sender.kind}:${sender.name}`);

/**
 * 轮次 → 格子:先切段(见 `segmentsOf`),再按「一格 n 段」均摊进轨道站得下的格数 `capacity`(0 = 还没量到,一段一格)。
 * 每一轮都归属某一格,❌ 没有一轮被丢在格子之外。
 */
export function ticksFromTurns(turns: readonly TimelineTurn[], capacity: number): TimelineTick[] {
  const segments = segmentsOf(turns);
  const stride = turnsPerTick(segments.length, capacity);
  const ticks: TimelineTick[] = [];
  for (let start = 0; start < segments.length; start += stride) {
    const from = segments[start]![0];
    const to = segments[Math.min(segments.length, start + stride) - 1]![1];
    const group = turns.slice(from, to + 1);
    const own = group.find(isOwnTurn);
    const senders = new Map<string, TimelineSender>();
    for (const turn of group) if (turn.sender && !isOwnTurn(turn) && !senders.has(senderKey(turn.sender))) senders.set(senderKey(turn.sender), turn.sender);
    ticks.push({
      turn: own ?? group[0]!,
      from: from + 1,
      to: to + 1,
      mine: own !== undefined,
      deliveries: group.filter((turn) => !isOwnTurn(turn)).length,
      senders: [...senders.values()],
    });
  }
  return ticks;
}
