import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { sendAddressesOf, type SendAddresses } from '@gugu/session-core/session-record/send-addresses';
import type { RenderUnit, SegmentCtx } from '../core/units';
import type { ChatMessage, TranscriptItem, TranscriptTurn } from '../model';
import type { MessageSenderTarget } from '../lib/sender-target';

export type ActivityActor = { id: string; name: string; target: MessageSenderTarget };
export type AgentActivityEvent = {
  id: string;
  direction: 'received' | 'sent' | 'sending';
  actors: readonly ActivityActor[];
  group?: ActivityActor;
  count: number;
  live: boolean;
};
export type AgentActivityGroup = { id: string; events: readonly AgentActivityEvent[]; messageIds?: readonly string[] };
export const activityId = (id: string) => `agent-activity:${id}`;

function actor(address: string, ctx: SegmentCtx, fallback?: string | null): ActivityActor | null {
  const known = ctx.actor?.(address);
  const match = /^(user|session):(.+)$/.exec(known?.id ?? address);
  if (!match) return null;
  return { id: known?.id ?? address, name: known?.name || fallback || ctx.translate('transcript.activityAgent'),
    target: address.startsWith('session:') ? { kind: 'session', sessionId: address.slice(8) }
      : match[1] === 'session' ? { kind: 'session', sessionId: match[2] } : { kind: 'sender', userId: match[2] } };
}

/** Identity comes from the authenticated envelope, never names or message prose. Mixed batches stay visible. */
export function incomingActivity(item: ChatMessage, ctx: SegmentCtx, live = false): AgentActivityEvent | null {
  if (item.role !== 'user' || item.sendStatus) return null;
  const segments = readDeliveryEnvelope(item.text)?.segments;
  if (!segments?.length || segments.some(part => {
    const facts = part.facts;
    if (!facts?.fromId) return true;
    // Legacy session-direct envelopes omit from_type. The existing identity directory/roster
    // may still prove the sender is an agent; absence of both facts remains unknown and visible.
    return facts.fromType ? facts.fromType !== 'agent' : ctx.actor?.(facts.fromId)?.type !== 'agent';
  })) return null;
  const actors = segments.map(part => actor(part.facts!.fromId!, ctx, part.facts!.from));
  if (actors.some(value => !value)) return null;
  return { id: item.id, direction: 'received', actors: actors as ActivityActor[], count: segments.length, live };
}

function sentGroup(addresses: SendAddresses, ctx: SegmentCtx): ActivityActor | undefined {
  const target = addresses.target;
  if (target.kind !== 'chat' || target.whisper) return;
  const id = target.conversationId || target.chatId;
  if (!id) return;
  const name = ctx.chatName?.(id);
  const kind = addresses.chatKind ?? ctx.chatKind?.(id);
  if (kind !== 'group' && kind !== 'topic') return;
  return { id, name: name || ctx.translate('transcript.activityGroup'), target: { kind: 'chat', chatId: id } };
}

/** Any human/unknown addressee keeps the output visible. A known, unaddressed group is A2A. */
export function outgoingActivity(id: string, addresses: SendAddresses | undefined | null, ctx: SegmentCtx, count = 1): AgentActivityEvent | null {
  if (!addresses) return null;
  const group = sentGroup(addresses, ctx);
  const recipients = addresses.recipients ?? (addresses.recipientsExplicit === false && group ? [] : null);
  if (!recipients || !recipients.length && !group) return null;
  if (recipients.some(address => ctx.actor?.(address)?.type !== 'agent')) return null;
  const actors = recipients.map(address => actor(address, ctx));
  if (actors.some(value => !value)) return null;
  return { id, direction: addresses.confirmed ? 'sent' : 'sending', actors: actors as ActivityActor[],
    ...(group ? { group } : {}), count: addresses.confirmed ? count : 0, live: !addresses.confirmed };
}

export function pendingActivity(items: readonly TranscriptItem[], turn: TranscriptTurn, ctx: SegmentCtx): AgentActivityEvent | null {
  const pending = items.findLast(item => item.kind === 'mcp-tool-call' && item.status === 'running');
  return pending ? outgoingActivity(pending.id, sendAddressesOf(pending, turn), ctx) : null;
}

export function hasUnconfirmedSend(items: readonly TranscriptItem[], turn: TranscriptTurn): boolean {
  return items.some(item => {
    if (item.kind !== 'mcp-tool-call' || item.status !== 'done') return false;
    const addresses = sendAddressesOf(item, turn);
    return addresses !== null && !addresses.confirmed;
  });
}

/** Proven group reply to the viewer: preserve one original source link, no session notification. */
export function viewerGroupReply(message: ChatMessage, ctx: SegmentCtx): ActivityActor | null {
  const addresses = message.sentAddresses;
  const viewer = ctx.viewerId?.replace(/^user:/, '');
  if (!viewer || !addresses?.confirmed || !addresses.recipients?.some(id => id === `user:${viewer}`)) return null;
  return sentGroup(addresses, ctx) ?? null;
}

/** Stable flat gate: no nested, unbounded message viewport and no second copy of original bubbles. */
export function foldActivityUnits(units: readonly RenderUnit[], previous?: AgentActivityGroup): RenderUnit[] {
  const result: RenderUnit[] = [];
  let current: AgentActivityGroup | undefined = previous;
  let header: RenderUnit<AgentActivityGroup> | undefined;
  let events = new Map(previous?.events.map(event => [event.id, event]));
  let messageIds = new Set(previous?.messageIds);
  let lastChild: RenderUnit | undefined;
  const finish = () => {
    if (current) {
      current = { ...current, events: [...events.values()], messageIds: [...messageIds] };
      if (header) header.data = current;
      if (lastChild) lastChild.activityGroup = current;
    }
    current = undefined;
    header = undefined;
    events = new Map();
    messageIds = new Set();
    lastChild = undefined;
  };
  for (const unit of units) {
    const event = unit.activityEvent;
    // The hover-only copy footer is part of this work, not a visible content boundary.
    if (!event && !(current && unit.kind === 'turn-completion')) { finish(); result.push(unit); continue; }
    if (!current) {
      current = { id: activityId(event!.id), events: [] };
      header = { id: current.id, itemId: current.id, groupId: current.id, groupRole: 'solo', gapBefore: unit.gapBefore,
        kind: 'agent-activity', data: current };
      result.push(header);
    }
    // A pending send and its receipt use the call identity, so completion never double counts it.
    if (event) events.set(event.id, event);
    if (unit.kind === 'message' && (unit.data as ChatMessage).conversationPart !== 'head') messageIds.add(unit.itemId);
    const child = { ...unit, activityFold: current.id, activityGroup: current,
      folds: [{ id: current.id, stored: true }, ...(unit.folds ?? [])] };
    result.push(child);
    lastChild = child;
  }
  finish();
  // Each range's final child carries its complete summary for incremental append/seam joining.
  return result;
}

/** Prepending older adjacent activity must not silently close the group being read. */
export function preserveActivityIds(previous: readonly RenderUnit[], next: RenderUnit[]): RenderUnit[] {
  const old = new Map<string, string>();
  for (const row of previous) if (row.kind === 'agent-activity') {
    for (const event of (row.data as AgentActivityGroup).events) old.set(event.id, row.id);
  }
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const row of next) if (row.kind === 'agent-activity') {
    const group = row.data as AgentActivityGroup;
    const stable = group.events.map(event => old.get(event.id)).find(id => id && !used.has(id));
    if (stable) { ids.set(group.id, stable); used.add(stable); }
  }
  const rename = (group: AgentActivityGroup): AgentActivityGroup => ids.has(group.id) ? { ...group, id: ids.get(group.id)! } : group;
  return next.map(row => row.kind === 'agent-activity' && ids.has(row.id)
    ? { ...row, id: ids.get(row.id)!, itemId: ids.get(row.id)!, groupId: ids.get(row.id)!, data: rename(row.data as AgentActivityGroup) }
    : row.activityFold && ids.has(row.activityFold) ? { ...row, activityFold: ids.get(row.activityFold),
      activityGroup: row.activityGroup ? rename(row.activityGroup) : undefined,
      folds: row.folds?.map(gate => ids.has(gate.id) ? { ...gate, id: ids.get(gate.id)! } : gate) } : row);
}

export function trailingActivity(units: readonly RenderUnit[]): AgentActivityGroup | undefined {
  return units.at(-1)?.activityGroup;
}

/** The preceding tier owns the only header. Its summary changes in place, not its DOM identity. */
const tailHeaderIndices = new WeakMap<readonly RenderUnit[], { id: string; index: number } | null>();
export function continuedActivityHeader(prefix: readonly RenderUnit[], tail: readonly RenderUnit[]): { index: number; unit: RenderUnit } | null {
  const first = tail[0];
  if (!first?.activityFold || first.kind === 'agent-activity') return null;
  let data = first.activityGroup!;
  for (const child of tail) {
    if (child.activityFold !== data.id) break;
    data = child.activityGroup!;
  }
  if (!tailHeaderIndices.has(prefix)) {
    const index = prefix.findLastIndex(unit => unit.kind === 'agent-activity');
    tailHeaderIndices.set(prefix, index < 0 ? null : { id: prefix[index].id, index });
  }
  const header = tailHeaderIndices.get(prefix);
  const index = header?.id === data.id ? header.index : -1;
  return index < 0 ? null : { index, unit: { ...prefix[index], data } };
}

export function appendActivityUnits(prefix: readonly RenderUnit[], tail: readonly RenderUnit[]): RenderUnit[] {
  const result = [...prefix, ...tail];
  const patch = continuedActivityHeader(prefix, tail);
  if (patch) result[patch.index] = patch.unit;
  return result;
}
