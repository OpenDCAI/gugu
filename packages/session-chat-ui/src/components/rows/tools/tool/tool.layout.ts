/**
 * tool.layout — geometry for the tool row's request / result payload panel.
 *
 * The panel's height is a Lane A input (core/define.ts): it is a function of
 * `ctx.expanded(id)`, the payload text and the available width, and nothing
 * else. That is what lets a collapsible row live in a virtualized list at all —
 * the expanded height is known before the row mounts, so toggling is an ordinary
 * `measure()` change the engine tweens and repositions around, not a DOM read
 * that has to be corrected after paint.
 *
 * Wrapping, not clipping: a tool's arguments arrive as one long JSON line more
 * often than not, and a row that needs horizontal scrolling to be read is the
 * defect #3363 fixed for execute. Both sections wrap at the measured width.
 * Overflow past `maxLines` scrolls vertically rather than being cut, so the cap
 * bounds the row's height without putting any of the payload out of reach.
 *
 * ── Why failure is a slot and not a field (#3334 row 33) ─────────────────────
 *
 * A failed call's reason is not a third channel in the data. ACP reports it in
 * the `content` blocks of the failing `tool_call_update`, which decode to
 * `outputText` / `rawOutput` and reach this row as `result` — the same field a
 * successful call's answer arrives in. (`ChatToolCall.error` is the host-facing
 * channel and no ACP producer writes it, so on the product path the reason is
 * always the result text.) Before this slot existed that left the reason painted
 * as an ordinary result — same marker, same colour, indistinguishable from
 * success — and reachable only once the reader found the chevron; a row whose
 * provider sent no content was not collapsible at all, so the reason had nowhere
 * to be and only the icon's native tooltip was left to carry it.
 *
 * Re-slotting that text as `error` is therefore a decision about how one text is
 * presented, not a second copy of it: the row shows it once, in the failure
 * slot, and the disclosure keeps only what is genuinely additional.
 *
 * ── The failure section is disclosed, not painted (owner, 2026-09-04) ─────────
 *
 * It used to be the one section not gated on `expanded`, on the reasoning that
 * nobody should have to open a row to learn why it is red. The owner overruled
 * that: "有个点出错的话不要直接把错误展开，我有需要我会点击去看" — an error must not
 * open itself; he will click when he wants it.
 *
 * The reasoning it replaces was not wrong about *what the reader needs*, only
 * about which channel carries it. The red mark in the status slot already says
 * "this one failed", unconditionally and in one glyph; what the old design added
 * was the reason's full text, unasked, on every failed row in the transcript. On
 * a screen with several failures that is a wall of provider output standing
 * between the reader and the turn — the cost is paid by every reader, while the
 * text is wanted by the one who chose to look.
 *
 * So the section is now gated like the others, and a failed row is collapsible
 * *because* of it: a red mark with nothing behind the chevron would say why the
 * row is red and give no way to find out. It remains a Lane A input (status,
 * text, width, and now `expanded` — nothing ephemeral), so it is measured
 * off-screen before mount like every other section.
 */

import type { FontConfig } from '@session-chat/core/config';
import { MEASURED_SCROLLBAR_GUTTER_X, measureSoftWrap } from '@session-chat/core/measure/soft-wrap';
import type { ChatToolCall } from '@session-chat/model';

/** Payload contract shared by generic and specialized tool rows. */
export type ToolPayloadItem = Pick<ChatToolCall, 'id' | 'status' | 'request' | 'result' | 'error'> & { reasoning?: string };

/** Which payload a section carries; doubles as its `data-slot` suffix. */
export type ToolPayloadSlot = 'request' | 'result' | 'error' | 'reasoning';

/**
 * Leading marker for each section's first line.
 *
 * Language-neutral on purpose. The row is inside the transcript, where every
 * other label passes through the host translator, and this package's translation
 * catalogue is the authoritative set of keys it may use — so a "Request" /
 * "Result" caption would have to be a new key in it. Direction arrows say the
 * same thing without one, and follow the marker idiom execute already uses to
 * separate a command from its output.
 *
 * Failure is deliberately not a third arrow: the reason a call failed is not a
 * direction of travel. `!` reads as a break in the request/result exchange
 * rather than another leg of it.
 */
const SLOT_MARKER: Record<ToolPayloadSlot, string> = {
  request: '→',
  result: '←',
  error: '!',
  reasoning: '⋯',
};

export type ToolPayloadLine = {
  text: string;
  visualLineCount: number;
  softWrapOffsets: number[];
};

export type ToolPayloadSection = {
  slot: ToolPayloadSlot;
  lines: ToolPayloadLine[];
  /** Visual lines the section would occupy uncapped. */
  contentLines: number;
};

/**
 * Width a payload line actually gets to fill, and therefore the width its wrap
 * is measured against: the row width minus the pinned scrollbar gutter, which
 * is reserved in every state so the reservation is the same on every platform.
 */
export function toolPayloadWidth(width: number): number {
  return Math.max(1, width - MEASURED_SCROLLBAR_GUTTER_X);
}

/**
 * Keys a structured failure payload puts its human sentence under.
 *
 * `error` is what MCP servers overwhelmingly serialise — the row that prompted
 * this reads `{ error, type, provider, retryable }` — and `message` is the same
 * slot in a JSON-RPC error member and in a serialised `Error`. Both are also
 * containers in the wild (`{ error: { message } }`), so the lookup walks into
 * an object under either name rather than giving up at the first `[object]`.
 *
 * Deliberately short. Every key added here is a key that could steal the
 * failure line away from a payload that meant something else by it, and the two
 * listed are the ones the protocols actually name.
 */
const FAILURE_REASON_KEYS = ['error', 'message'] as const;

/** How far into nested reason containers to walk. `{error:{message:"…"}}` is 2. */
const FAILURE_REASON_MAX_DEPTH = 3;

function readFailureReason(value: unknown, depth: number): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (depth >= FAILURE_REASON_MAX_DEPTH) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const key of FAILURE_REASON_KEYS) {
    const reason = readFailureReason((value as Record<string, unknown>)[key], depth + 1);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * The sentence inside a structured failure payload, when the text is one.
 *
 * A tool that fails through MCP does not report prose — it reports a serialised
 * object, and the row was painting that object: `{`, then four quoted fields,
 * of which one is the reason and three are machine bookkeeping. The reader had
 * to parse JSON by eye to find out what went wrong, and the tighter failure cap
 * (six lines) meant a long payload could push the reason out of the reserved
 * height entirely.
 *
 * Only a top-level `{…}` is considered. A bare JSON string would come back with
 * its quotes stripped for no gain, and an array is a list of results rather than
 * an envelope with a reason in it — neither is a payload this is reading.
 *
 * Undefined means "not a structured payload, or one with no sentence in it", and
 * the caller then shows the text exactly as it arrived. Nothing is ever dropped:
 * see toolDisclosedResult for where the full payload goes.
 */
export function toolFailureReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return readFailureReason(parsed, 0);
}

/**
 * The text explaining why this call failed, or undefined when it did not fail.
 *
 * `error` first because a host that sets it meant that text specifically; the
 * result text second because that is where ACP actually puts a failure report.
 * Both are checked only in the error state: a `result` on a successful call is
 * an answer, and the same string is not a failure just because it was stored in
 * the same place.
 *
 * Whichever field it came from is then read as a possible structured payload:
 * the failure section says why the call failed, and when the provider wrapped
 * that reason in an object, the reason is the string inside — not the object
 * around it.
 */
export function toolFailureText(item: ToolPayloadItem): string | undefined {
  if (item.status !== 'error') return undefined;
  const text = item.error ?? item.result;
  if (text === undefined) return undefined;
  return toolFailureReason(text) ?? text;
}

/**
 * Result text the disclosure has left to reveal.
 *
 * Absent when the failure section is already showing that exact string — the
 * row states one text once. A host that supplies a distinct `error` keeps its
 * result disclosable, because then the two really are two different readings.
 *
 * A structured payload is that second reading too: the failure line carries the
 * sentence, the disclosure keeps the object it came wrapped in, so the fields
 * around the reason (`type`, `provider`, `retryable` on the row that prompted
 * this) stay a chevron away instead of being either dropped or made to stand in
 * for the reason. Such a row therefore grows a chevron it did not have before —
 * correctly, because it now really does have something behind it.
 */
export function toolDisclosedResult(item: ToolPayloadItem): string | undefined {
  if (!item.result) return undefined;
  return item.result === toolFailureText(item) ? undefined : item.result;
}

/**
 * True when the row has something to reveal — the only reason to be collapsible.
 *
 * The failure reason counts. It is now disclosed rather than painted, so a row
 * whose only text is its reason is exactly the row that most needs a chevron:
 * without one the red mark would announce a failure the reader has no way to
 * open. (This is the inverse of the rule that stood here before, and it inverts
 * for the same reason the section moved — see the module header.)
 *
 * A disclosure control that reveals nothing is still the promise this row does
 * not make: a row with no request, no result and no reason grows no chevron.
 */
export function hasToolPayload(item: ToolPayloadItem): boolean {
  return Boolean(item.request || item.reasoning || toolDisclosedResult(item) || toolFailureText(item));
}

function sectionSourceLines(slot: ToolPayloadSlot, text: string): string[] {
  const marker = SLOT_MARKER[slot];
  // The marker is part of the measured text, the way execute's `$` is: a gutter
  // rendered outside the measured line would make the painted width disagree
  // with the width the wrap was computed against.
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
    .split('\n')
    .map((line, index) => `${index === 0 ? marker : ' '} ${line}`);
}

/**
 * Lay out the row's payload sections at `width`.
 *
 * Returns the sections in display order; an absent payload contributes nothing,
 * so a row with only a result renders only a result. Every section is gated on
 * `expanded`, the failure reason included — a collapsed row is its header.
 *
 * Failure still leads. It is what the reader opened the row to find out, so it
 * is the first thing under the header when the row opens; the request and the
 * raw result follow as the evidence behind it.
 */
export function layoutToolPayload(
  item: ToolPayloadItem,
  width: number,
  fonts: FontConfig,
  expanded: boolean
): ToolPayloadSection[] {
  const contentWidth = toolPayloadWidth(width);
  const sections: ToolPayloadSection[] = [];

  const texts: Array<[ToolPayloadSlot, string | undefined]> = [
    ['error', expanded ? toolFailureText(item) : undefined],
    ['request', expanded ? item.request : undefined],
    ['reasoning', expanded ? item.reasoning : undefined],
    ['result', expanded ? toolDisclosedResult(item) : undefined],
  ];

  for (const [slot, text] of texts) {
    if (!text) continue;
    const lines = sectionSourceLines(slot, text).map((line) => ({
      text: line,
      ...measureSoftWrap(line, contentWidth, fonts.code.font),
    }));
    sections.push({
      slot,
      lines,
      contentLines: lines.reduce((sum, line) => sum + line.visualLineCount, 0),
    });
  }

  return sections;
}

export type ToolPayloadGeometry = {
  /** Reserved height of the whole panel. */
  panelH: number;
  /** Per-section reserved and intrinsic heights, in display order. */
  sections: Array<{
    slot: ToolPayloadSlot;
    lines: ToolPayloadLine[];
    sectionH: number;
    contentH: number;
  }>;
};

/** Line cap for the panel's sections. */
export type ToolPayloadCaps = {
  /** Cap for the sections the reader opened the row to see — all of them. */
  panelMaxLines: number;
};

/**
 * Turn laid-out sections into the heights the row reserves.
 *
 * Each section is capped independently, so one enormous result cannot squeeze
 * the request out of view.
 *
 * One cap for all three. Failure used to answer to a tighter one, on the ground
 * that it was spent on every failed row whether or not anyone was reading it —
 * a stack trace at the panel cap would turn a run of failures into a wall. That
 * ground is gone now that the section only appears when the row is opened: a
 * reader who clicked a failed row is asking for its trace exactly as a reader
 * who clicked a successful one is asking for its output, and giving the reason
 * half the height of the raw payload printed underneath it would be an odd way
 * to answer. The cap bounds the reserved height only; the section scrolls, so
 * the rest of the trace stays reachable either way.
 */
export function toolPayloadGeometry(
  sections: ToolPayloadSection[],
  codeLineH: number,
  caps: ToolPayloadCaps
): ToolPayloadGeometry {
  const laid = sections.map((section) => {
    const cap = caps.panelMaxLines * codeLineH;
    const contentH = section.contentLines * codeLineH;
    return {
      slot: section.slot,
      lines: section.lines,
      sectionH: Math.min(contentH, cap),
      contentH,
    };
  });
  return {
    panelH: laid.reduce((sum, section) => sum + section.sectionH, 0),
    sections: laid,
  };
}
