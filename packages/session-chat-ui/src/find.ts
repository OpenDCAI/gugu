import { batch } from 'solid-js';
import { SEGMENTERS, UNIT_REGISTRY } from '@session-chat/components/engine/unit-registry';
import { srOnly } from '@session-chat/components/rows/message/message.css';
import { thinkingSummary } from '@session-chat/components/rows/thinking/thinking-summary';
import { diffUnitDef } from '@session-chat/components/rows/tools/diff/diff.def';
import { selectPreview } from '@session-chat/components/rows/tools/diff/diff-lines';
import { createExecuteLines, executeCommandChipText } from '@session-chat/components/rows/tools/execute/execute.layout';
import { toolDisclosedResult, toolFailureText } from '@session-chat/components/rows/tools/tool/tool.layout';
import type { ChatContext } from '@session-chat/chat-context';
import type { EngineControls } from '@session-chat/ChatRoot';
import type { ChatCaches } from '@session-chat/core/caches';
import { blockPlainText } from '@session-chat/core/markdown/plain-text';
import type { FoldGate, RenderUnit } from '@session-chat/core/units';
import type { ChatDiff, ChatExecute, ChatFileOpToolCall, ChatItem, ChatMessage } from '@session-chat/model';
import type { ChatSubagentToolCall, ChatThinking, ChatToolCall, TurnOutcomeItem } from '@session-chat/model';
import type { ChatState } from '@session-chat/state/chat-state';
import { flattenTier, trailingDayKey, turnOutcomeDetailId, type ItemNode } from '@session-chat/state/flatten';
import { segmentCtxFor } from '@session-chat/state/segment-ctx';

export type ChatFindStatus = { currentIndex: number; total: number };
type Part = { text: string; gates: readonly FoldGate[] };
type Entry = { unit: RenderUnit; order: number; parts: Part[]; userCard: boolean };
type Match = { entry: Entry; part: number; start: number };
type Caches = Pick<ChatCaches, 'parseBlocks' | 'parseBlocksStreaming' | 'computeDiff'>;
type Payload = Pick<ChatToolCall, 'id' | 'status' | 'request' | 'result' | 'error'>;
const HIGHLIGHT = 'gugu-chat-find';
const EMPTY: ChatFindStatus = { currentIndex: 0, total: 0 };
const NONE: readonly FoldGate[] = [];
/** A jump waits at most this many frames for its row to mount and settle. */
const MAX_FRAMES = 90;
const behind = (outer: readonly FoldGate[], id: string): readonly FoldGate[] => [...outer, { id, stored: true }];
const part = (text: string | null | undefined, gates = NONE): Part[] => (text ? [{ text, gates }] : []);
const nonWs = (text: string): number => text.match(/\S/gu)?.length ?? 0;

/** The text each row paints, from the same functions its renderer uses, tagged with the folds hiding it. */
function unitParts(unit: RenderUnit, caches: Caches): Part[] {
  const md = (id: string, text: string, streaming?: boolean) =>
    (streaming ? caches.parseBlocksStreaming : caches.parseBlocks)(id, text).map(blockPlainText).join('\n\n');
  const payload = (item: Payload, outer: readonly FoldGate[]): Part[] => {
    const gates = behind(outer, item.id);
    const result = toolDisclosedResult(item);
    return [...part(toolFailureText(item), gates), ...part(item.request, gates), ...part(result, gates)];
  };
  const leaf = (item: ChatItem, outer: readonly FoldGate[]): Part[] => {
    switch (item.kind) {
      case 'tool': {
        const tool = item as ChatToolCall;
        return [...part(tool.name, outer), ...part(tool.inputSummary, outer), ...payload(tool, outer)];
      }
      case 'execute': {
        const exec = item as ChatExecute;
        const body = createExecuteLines(exec).map((line) => line.text).join('\n');
        const head = [...part(exec.inputSummary, outer), ...part(executeCommandChipText(exec), outer)];
        return [...head, ...part(body, behind(outer, exec.id)), ...payload(exec, outer)];
      }
      case 'file-op': {
        const op = item as ChatFileOpToolCall;
        const paths = op.ops.map((o) => o.path).join('\n');
        return [...part(paths, op.ops.length > 1 ? behind(outer, op.id) : outer), ...payload(op, outer)];
      }
      case 'diff': {
        const diff = item as ChatDiff;
        const { maxLines, context } = diffUnitDef.vars ?? { maxLines: 12, context: 1 };
        const rows = diff.awaitingPermission ? [] : diff.patches.flatMap(patch => selectPreview(caches.computeDiff(patch), maxLines, context));
        const paths = diff.patches.flatMap(patch => patch.changes.map(change => typeof change.path === 'string' ? change.path : change.operation));
        return [...part(paths.join('\n'), outer), ...part(diff.error, outer), ...part(rows.map(row => row.text).join('\n'), outer)];
      }
      case 'subagent': {
        const sub = item as ChatSubagentToolCall;
        return [...part(sub.task, outer), ...payload(sub, outer)];
      }
      default:
        return [];
    }
  };
  const group = (node: ItemNode, outer: readonly FoldGate[]): Part[] => {
    const item = node.item as ChatItem;
    const name = item.kind === 'tool' ? part((item as ChatToolCall).name, outer) : [];
    const head = item.kind === 'subagent' ? leaf(item, outer) : name;
    const inner = behind(outer, item.id);
    const child = (c: ItemNode) => (c.children.length > 0 ? group(c, inner) : leaf(c.item as ChatItem, inner));
    return [...head, ...node.children.flatMap(child)];
  };
  switch (unit.kind) {
    case 'message': {
      const msg = unit.data as ChatMessage;
      return part(md(msg.id, msg.text, msg.streaming));
    }
    case 'thinking': {
      const thinking = unit.data as ChatThinking;
      const summary = thinking.status === 'thinking' ? undefined : thinkingSummary(thinking.text);
      return [...part(summary), ...part(md(thinking.id, thinking.text ?? ''), behind(NONE, thinking.id))];
    }
    case 'turn-outcome': {
      const { outcome, turnId } = unit.data as TurnOutcomeItem;
      return outcome.kind === 'error' ? part(outcome.detail?.trim(), behind(NONE, turnOutcomeDetailId(turnId))) : [];
    }
    case 'tool-group':
      return group(unit.data as ItemNode, NONE);
    default:
      return leaf(unit.data as ChatItem, NONE);
  }
}

/** The mounted row's range for the match: the occurrence nearest `expected` non-whitespace characters in. */
function locate(row: HTMLElement, query: string, expected: number): Range | null {
  const needle = query.replace(/\s+/gu, '').toLowerCase();
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      for (let el = node.parentElement; el && el !== row; el = el.parentElement) {
        if (el.getAttribute('aria-hidden') === 'true' || el.classList.contains(srOnly)) return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  const at: { node: Text; offset: number }[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    let offset = 0;
    for (const ch of node.data) {
      if (/\S/u.test(ch)) {
        const lower = ch.toLowerCase();
        text += lower;
        for (let k = 0; k < lower.length; k++) at.push({ node, offset });
      }
      offset += ch.length;
    }
  }
  let best = -1;
  for (let i = needle ? text.indexOf(needle) : -1; i !== -1; i = text.indexOf(needle, i + 1)) {
    if (best === -1 || Math.abs(i - expected) < Math.abs(best - expected)) best = i;
    if (i > expected) break;
  }
  const first = at[best];
  const last = at[best + needle.length - 1];
  if (best === -1 || !first || !last) return null;
  const range = row.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + String.fromCodePoint(last.node.data.codePointAt(last.offset) ?? 0).length);
  return range;
}

/** Scroll every inner scroller between the row and the range (tool panes, output windows) onto the range. */
function revealInner(range: Range, row: HTMLElement): void {
  const start = range.startContainer;
  // Process leaves sit inside an independently scrolling viewport, outside the
  // leaf row itself. Include it when revealing a match, just like tool outputs.
  const stop = row.closest('[data-slot="conversation-process-steps"]')?.parentElement ?? row;
  for (let el = start instanceof HTMLElement ? start : start.parentElement; el && el !== stop; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1 || !/^(auto|scroll)$/.test(getComputedStyle(el).overflowY)) continue;
    const box = el.getBoundingClientRect();
    const hit = range.getBoundingClientRect();
    el.scrollTop += hit.top + hit.height / 2 - (box.top + box.height / 2);
  }
}

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void };
let painter: object | null = null;
/** One highlight registry per document: only the find that painted the current highlight may erase it. */
function paint(owner: object, range: Range | null): void {
  const g = globalThis as unknown as { CSS?: { highlights?: Highlights }; Highlight?: new (r: Range) => unknown };
  if (!g.CSS?.highlights || !g.Highlight) return;
  if (range) {
    painter = owner;
    g.CSS.highlights.set(HIGHLIGHT, new g.Highlight(range));
  } else if (painter === owner) {
    painter = null;
    g.CSS.highlights.delete(HIGHLIGHT);
  }
}

/** Find over the model (every row, folds open); a jump opens the match's folds, anchors its row, then highlights. */
export function createChatFind(deps: {
  parent: HTMLElement;
  context: ChatContext;
  state: () => ChatState;
  controls: EngineControls;
}) {
  const token = {};
  let query = '';
  let matches: Match[] = [];
  let current = -1;
  let range: Range | null = null;
  let frame = 0;
  let identityFrame = 0;
  let observer: MutationObserver | null = null;

  const rowOf = (itemId: string) =>
    deps.parent.querySelector<HTMLElement>(`[data-chat-canvas] [data-item-id="${CSS.escape(itemId)}"]`);
  const isOpen = (gate: FoldGate) => deps.state().viewState.isCollapsed(gate.id) === gate.stored;
  /** The part of the scroller not covered by the composer floating over its bottom. */
  const band = () => {
    const box = deps.parent.querySelector('[data-chat-scroll]')?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
    const slot = deps.controls.composerSlot?.getBoundingClientRect();
    const covered = slot && slot.height > 0 && slot.top > box.top && slot.top < box.bottom;
    return { top: box.top, bottom: covered ? slot.top : box.bottom };
  };
  const scrollTo = (itemId: string, offset: number) =>
    deps.controls.setScrollMode?.({ kind: 'anchor', itemId, edge: 'top', offset });
  const expected = (m: Match) =>
    m.entry.parts
      .slice(0, m.part)
      .filter((p) => p.gates.every(isOpen))
      .reduce((n, p) => n + nonWs(p.text), nonWs((m.entry.parts[m.part] as Part).text.slice(0, m.start)));

  const allUnits = () => {
    const state = deps.state();
    const caches: ChatCaches = { ...deps.context.sharedCaches, ...state.parseCaches };
    // Every row the transcript can show: flattened like the engine does, with all folds open.
    const { committedTurns, activeTurnSnapshot: live } = state.transcript.state;
    const ctx = (active: boolean) => ({ ...segmentCtxFor(deps.context, state, caches, active), revealAllFolds: true });
    const head = flattenTier(committedTurns, ctx(false), SEGMENTERS, UNIT_REGISTRY);
    const dayKey = trailingDayKey(committedTurns, undefined, ctx(false).latestTurnId);
    const tail = live ? flattenTier([live], ctx(true), SEGMENTERS, UNIT_REGISTRY, head.at(-1)?.kind, dayKey) : [];
    return { units: [...head, ...tail], caches };
  };

  const search = () => {
    const { units, caches } = allUnits();
    const needle = query.toLowerCase();
    const found: Match[] = [];
    units.forEach((unit, order) => {
      const msg = unit.data as ChatMessage;
      const userCard = unit.kind === 'message' && msg.role === 'user' && !msg.guguDelivery;
      const entry = { unit, order, parts: unitParts(unit, caches), userCard };
      entry.parts.forEach((p, part) => {
        const hay = p.text.toLowerCase();
        for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
          found.push({ entry, part, start: at });
        }
      });
    });
    return { units, found };
  };

  const show = (next: Range | null) => {
    range = next;
    paint(token, next);
    observer?.disconnect();
    observer = null;
    const canvas = deps.parent.querySelector('[data-chat-canvas]');
    if (!next || !canvas) return;
    // A recycled or re-rendered row detaches the range: find the match again in the same row.
    observer = new MutationObserver(() => {
      const m = matches[current];
      const row = m && !frame && !range?.startContainer.isConnected ? rowOf(m.entry.unit.itemId) : null;
      if (!m || !row) return;
      range = locate(row, query, expected(m));
      paint(token, range);
    });
    observer.observe(canvas, { childList: true, subtree: true, characterData: true });
  };

  const reveal = (m: Match) => {
    const s = deps.state();
    const itemId = m.entry.unit.itemId;
    batch(() => {
      for (const gate of [...(m.entry.unit.folds ?? []), ...(m.entry.parts[m.part] as Part).gates]) {
        s.viewState.setCollapsed(gate.id, gate.stored);
      }
      if (m.entry.userCard && s.expandedUserId.get() !== itemId) s.expandedUserId.set(itemId);
    });
    let frames = 0;
    let last = '';
    const tick = () => {
      frame = 0;
      const row = rowOf(itemId);
      if (!row && ++frames === 2) scrollTo(itemId, -(band().bottom - band().top) / 3);
      const found = row ? locate(row, query, expected(m)) : null;
      // Settled = the match sits at the same place in an unchanged row for two frames running.
      const rowBox = row?.getBoundingClientRect();
      const sig = found && rowBox
        ? `${Math.round(found.getBoundingClientRect().top - rowBox.top)}|${Math.round(rowBox.height)}`
        : '';
      if (row && found && rowBox && (sig === last || frames >= MAX_FRAMES)) {
        revealInner(found, row);
        const hit = found.getBoundingClientRect();
        const view = band();
        if (hit.top < view.top + 24 || hit.bottom > view.bottom - 24) {
          scrollTo(itemId, hit.top - rowBox.top + hit.height / 2 - (view.bottom - view.top) / 2);
        }
        return show(found);
      }
      if (row) frames++;
      last = sig;
      if (frames >= MAX_FRAMES) return show(null);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  };

  const go = (index: number): ChatFindStatus => {
    cancelAnimationFrame(frame);
    current = index;
    const m = matches[index];
    if (m) reveal(m);
    else show(null);
    return m ? { currentIndex: index + 1, total: matches.length } : EMPTY;
  };

  const find = (next: string): ChatFindStatus => {
    query = next.trim() ? next : '';
    matches = [];
    // Clearing (also on every model swap) must not measure the DOM.
    if (!query) return go(-1);
    const { units, found } = search();
    matches = found;
    // Start at the first match at or below the top row on screen.
    const view = band();
    const top = [...deps.parent.querySelectorAll<HTMLElement>('[data-chat-canvas] [data-item-id]')]
      .filter((row) => row.getBoundingClientRect().bottom > view.top && row.getBoundingClientRect().height > 0)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    const topOrder = top ? units.findIndex((u) => u.itemId === top.dataset.itemId) : 0;
    return go(matches.length === 0 ? -1 : Math.max(0, matches.findIndex((m) => m.entry.order >= topOrder)));
  };

  const openItem = (itemId: string): boolean => {
    const unit = allUnits().units.find(unit => unit.itemId === itemId);
    if (!unit) return false;
    const state = deps.state();
    batch(() => {
      for (const gate of unit.folds ?? []) state.viewState.setCollapsed(gate.id, gate.stored);
      if (unit.kind === 'message' && (unit.data as ChatMessage).conversationNarration) {
        state.viewState.setCollapsed(`${itemId}:conversation-text`, true);
      }
    });
    return true;
  };

  return {
    find,
    /** Open the folds an item sits in (the same fold map as find, without matching private text); nothing moves. */
    openItem,
    /** Identity navigation: open the item's folds, then position its row. */
    revealItem(itemId: string): boolean {
      if (!openItem(itemId)) return false;
      const state = deps.state();
      scrollTo(itemId, -8);
      // The process has its own bounded scroll viewport; position its actual row too.
      cancelAnimationFrame(identityFrame);
      identityFrame = requestAnimationFrame(() => {
        if (deps.state() === state) deps.controls.scrollToItem(itemId, { align: 'start', offset: -8 });
      });
      return true;
    },
    step(direction: 'next' | 'prev'): ChatFindStatus {
      const was = matches[current];
      matches = query ? search().found : [];
      const n = matches.length;
      // The same match again (the transcript may have grown or been paged in around it), else start over.
      const same = (m: Match) =>
        !!was && m.entry.unit.id === was.entry.unit.id && m.part === was.part && m.start === was.start;
      const at = matches.findIndex(same);
      if (at === -1) return go(n === 0 ? -1 : direction === 'next' ? 0 : n - 1);
      return go((at + (direction === 'next' ? 1 : n - 1)) % n);
    },
    clear: () => { cancelAnimationFrame(identityFrame); void find(''); },
  };
}
