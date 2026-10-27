import type { ToolImage, ToolImageRef, ToolNode, TranscriptItem, TranscriptTurn } from '../acp/client';
import type {
  TimelineAfterResult,
  TimelineBatch,
  TimelineOlderResult,
  TimelineSnapshot,
  TurnPatch,
} from './contract';

/**
 * Phone and desktop transport projections share field trimming, lazy image references,
 * and a UTF-8 page budget. Raw records stay intact.
 *
 * trimmedChars makes shortened tool content visible to the reader. Omitted older
 * turns remain reachable through each API's existing exclusive cursor.
 * Unchanged objects retain their references on the streaming path.
 */

/** 单个字段的上限（字符）。8K 够看清一条命令的开头与大多数工具的全部输出。 */
export const TRANSPORT_TEXT_LIMIT = 8_192;

/** 会被裁的那些格子：工具调用带回来的大块文本。❌ 不裁用户自己写的消息。 */
const TRIMMED_FIELDS = ['outputText', 'rawOutput', 'rawInput', 'content', 'oldText', 'newText'] as const;

/**
 * 工具交回来的图**不随记录走**:每张只留 `{ mimeType, chars }`(`imageRefs`),手机等那张图滚进视口、那一轮
 * 展开了,再按 (会话, 条目, 第几张) 去机器上取(`sessionTimeline.sessionToolImage`)。
 *
 * 为什么(owner 10-15「手机上看的话每张图传过去岂不是很 costly」,155 定):随记录下发时,app_check 的四张约
 * 120K 字跟着冷开那一份一起下来,可轮次默认是折叠的,人还没看见(2026-10-15 实抓手机流量)。
 * 图不算裁掉的字 —— 它没丢,取得到,❌ 记进 `trimmedChars`。
 */
function imageRefsOf(images: readonly ToolImage[]): ToolImageRef[] {
  return images.map((image) => ({ mimeType: image.mimeType, chars: image.data.length }));
}

function isToolNode(item: TranscriptItem): item is ToolNode {
  return item.kind !== 'message' && item.kind !== 'thinking';
}

/** @returns 裁过的那一份，或者原对象（一个字都没超时）。 */
function trimToolNode(node: ToolNode, limit: number): ToolNode {
  const source = node as unknown as Record<string, unknown>;
  let dropped = 0;
  let patch: Record<string, unknown> | null = null;

  for (const field of TRIMMED_FIELDS) {
    const value = source[field];
    if (typeof value !== 'string' || value.length <= limit) continue;
    patch ??= {};
    patch[field] = value.slice(0, limit);
    dropped += value.length - limit;
  }

  const images = node.kind === 'tool-group' ? undefined : node.images;
  if (images) {
    patch ??= {};
    patch.imageRefs = imageRefsOf(images);
  }

  // 工具组与嵌套调用都往下走：大输出常常挂在子调用上（一个 Bash 组里的某一条）。
  const children = node.children;
  const trimmedChildren = children ? trimToolNodes(children, limit) : children;
  if (trimmedChildren !== children) {
    patch ??= {};
    patch.children = trimmedChildren;
  }

  if (!patch) return node;
  // 累加：这条调用**总共**少了多少字。它自己被裁过，`dropped` 就落在自己这一格上。
  const next: Record<string, unknown> = { ...node, ...patch, ...(dropped > 0 ? { trimmedChars: dropped } : {}) };
  delete next.images;
  return next as unknown as ToolNode;
}

function trimToolNodes(nodes: readonly ToolNode[], limit: number): ToolNode[] {
  let changed = false;
  const next = nodes.map((node) => {
    const trimmed = trimToolNode(node, limit);
    if (trimmed !== node) changed = true;
    return trimmed;
  });
  return changed ? next : (nodes as ToolNode[]);
}

export function trimItemsForTransport(
  items: readonly TranscriptItem[],
  limit = TRANSPORT_TEXT_LIMIT,
): TranscriptItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (!isToolNode(item)) return item;
    const trimmed = trimToolNode(item, limit);
    if (trimmed !== item) changed = true;
    return trimmed as TranscriptItem;
  });
  return changed ? next : (items as TranscriptItem[]);
}

export function trimTurnsForTransport(
  turns: readonly TranscriptTurn[],
  limit = TRANSPORT_TEXT_LIMIT,
): TranscriptTurn[] {
  let changed = false;
  const next = turns.map((turn) => {
    const items = trimItemsForTransport(turn.items, limit);
    if (items === turn.items) return turn;
    changed = true;
    return { ...turn, items };
  });
  return changed ? next : (turns as TranscriptTurn[]);
}

function trimPatches(patches: readonly TurnPatch[], limit: number): TurnPatch[] {
  let changed = false;
  const next = patches.map((patch) => {
    const items = trimItemsForTransport(patch.items, limit);
    if (items === patch.items) return patch;
    changed = true;
    return { ...patch, items };
  });
  return changed ? next : (patches as TurnPatch[]);
}

/**
 * 首屏（以及每一次「往前翻」）打包出去的**总量**上限，字节。
 *
 * 逐字段裁到 8K 只挡得住「一条工具输出几十万字」那一种胖法。导入进来的 CLI 会话是另一种：
 * 单条不长，但一轮里几十上百条 —— 实测一份 39MB 的 claude 记录，最近 20 轮里 204~373 条条目，
 * 逐字段裁完仍有 0.28~0.81MB，而**逐字段裁只省下 10%**（没有哪一条超过 8K）。
 * 这一包要走设备 RPC 的广播通道：单包上限 3000KB、每秒 100 条，且**整个库所有连接共用**。
 * 给一部手机的首屏发 0.8MB，既慢又在吃别人的额度。
 *
 * 所以这里再加一道总量闸：从**最旧**的那一轮开始丢，直到装得下。丢掉的那些不是没了 ——
 * `hasOlder` 会被抬成 true，手机往回翻时照原路 `getOlder` 取得到，与「快照本来就只给最近 N 轮」
 * 是同一套分页语义。❌ 不从最新的那头丢：首屏要的就是最近发生的事。
 * ❌ 也不允许丢到一轮不剩 —— 一轮再大也得发出去，否则屏幕上什么都没有，
 * 而「什么都没有」和「这条会话是空的」在界面上分不出来。
 */
export const TRANSPORT_PAYLOAD_BUDGET = 128 * 1024;

/**
 * 把一段轮压进总量预算。
 *
 * @returns 装得下的那一段（可能比传进来的短），以及是否真的丢过。
 */
function fitTurnsToBudget(
  turns: readonly TranscriptTurn[],
  budget: number,
): { turns: readonly TranscriptTurn[]; dropped: boolean } {
  if (turns.length <= 1) return { turns, dropped: false };
  // 每一轮各量一次（❌ 别按平均值估：轮与轮之间体量差几十倍是常态），
  // 再从**最新**那头往回累加，装不下就在那里断开。
  const encoder = new TextEncoder();
  const sizes = turns.map((turn) => encoder.encode(JSON.stringify(turn)).byteLength);
  let used = 2; // JSON array brackets.
  let start = turns.length - 1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const next = used + sizes[i] + (i < turns.length - 1 ? 1 : 0);
    // 最新的那一轮无条件保留，哪怕它自己就超预算。
    if (next > budget && i < turns.length - 1) break;
    used = next;
    start = i;
  }
  return start === 0 ? { turns, dropped: false } : { turns: turns.slice(start), dropped: true };
}

/** The phone and desktop cursor APIs use one field trim and one UTF-8 page budget. */
function trimTurnPageForTransport<T extends { turns: TranscriptTurn[]; hasOlder: boolean }>(
  page: T,
  limit: number,
  budget: number,
): T {
  const trimmed = trimTurnsForTransport(page.turns, limit);
  const fitted = fitTurnsToBudget(trimmed, budget);
  if (trimmed === page.turns && !fitted.dropped) return page;
  return { ...page, turns: fitted.turns as TranscriptTurn[], hasOlder: page.hasOlder || fitted.dropped };
}

/** Adapt the same page budget to desktop's exclusive numeric cursor, keeping stored origins aligned. */
export function trimCursorPageForTransport<T extends {
  turns: TranscriptTurn[];
  nextCursor: number | null;
  originTurnIds?: readonly string[];
}>(
  page: T,
  limit = TRANSPORT_TEXT_LIMIT,
  budget = TRANSPORT_PAYLOAD_BUDGET,
): T {
  const trimmed = trimTurnPageForTransport(
    { turns: page.turns, hasOlder: page.nextCursor !== null }, limit, budget,
  );
  if (trimmed.turns === page.turns) return page;
  const skipped = page.turns.length - trimmed.turns.length;
  return {
    ...page,
    turns: trimmed.turns,
    nextCursor: trimmed.hasOlder ? (trimmed.turns[0]?.seq ?? null) : null,
    ...(page.originTurnIds ? { originTurnIds: page.originTurnIds.slice(skipped) } : {}),
  };
}

export function trimSnapshotForTransport(
  snapshot: TimelineSnapshot,
  limit = TRANSPORT_TEXT_LIMIT,
  budget = TRANSPORT_PAYLOAD_BUDGET,
): TimelineSnapshot {
  return trimTurnPageForTransport(snapshot, limit, budget);
}

export function trimBatchForTransport(
  batch: TimelineBatch,
  limit = TRANSPORT_TEXT_LIMIT,
): TimelineBatch {
  const turns = trimPatches(batch.turns, limit);
  return turns === batch.turns ? batch : { ...batch, turns };
}

export function trimOlderForTransport(
  older: TimelineOlderResult,
  limit = TRANSPORT_TEXT_LIMIT,
  budget = TRANSPORT_PAYLOAD_BUDGET,
): TimelineOlderResult {
  return trimTurnPageForTransport(older, limit, budget);
}

export function trimAfterResultForTransport(
  result: TimelineAfterResult,
  limit = TRANSPORT_TEXT_LIMIT,
): TimelineAfterResult {
  if (result.ok) {
    const batch = trimBatchForTransport(result.batch, limit);
    return batch === result.batch ? result : { ...result, batch };
  }
  const snapshot = trimSnapshotForTransport(result.snapshot, limit);
  return snapshot === result.snapshot ? result : { ...result, snapshot };
}
