import * as Y from 'yjs';

/**
 * `f.applyFrom(snapshot, next)` (摩擦单 F59): an App that edits by rewriting the whole text says what it changed
 * relative to what it last read (`f.snapshot()`), and only that lands — on the text as it is now. Whatever others
 * typed since the snapshot stays, and what neither side changed is not touched: no letter of it is deleted and
 * written back.
 *
 * - The changes are the hunks of a real diff of `snapshot.text → next` (lines first, then letters within the lines
 *   that changed), never a common prefix and suffix: a prefix/suffix diff against the live text reads everything
 *   typed elsewhere meanwhile as deleted (L7 S12: 12 of B's 15 letters went).
 * - They are placed by the snapshot's own coordinates: each letter of `snapshot.text` is found in the live text by
 *   its Yjs identity (visible in the Yjs snapshot taken with it). A deletion removes only those letters still there;
 *   an insertion goes where the replaced letters were (before the snapshot letter that followed it), after anything
 *   others put in that gap.
 */

interface Hunk {
  /** Range of the base text replaced … */
  from: number;
  to: number;
  /** … by this. */
  insert: string;
}

const MAX_LINE_EDITS = 2000;
const MAX_LETTER_EDITS = 1000;

/**
 * Myers' shortest edit script between two token lists, as hunks `[aFrom, aTo) → [bFrom, bTo)`; `null` when it
 * needs more than `maxD` edits (the caller takes a coarser answer).
 */
function myers<T>(a: readonly T[], b: readonly T[], maxD: number): { aFrom: number; aTo: number; bFrom: number; bTo: number }[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;
  // Walk back: every step is one deletion (a) or insertion (b), between runs of equal tokens.
  const edits: { a: number; b: number; kind: 'del' | 'ins' }[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const before = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && before[offset + k - 1]! < before[offset + k + 1]!);
    const prevK = down ? k + 1 : k - 1;
    const prevX = before[offset + prevK]!;
    const prevY = prevX - prevK;
    // From (prevX, prevY): down takes b[prevY], right drops a[prevX]; the equal run after it needs nothing.
    edits.push({ a: prevX, b: prevY, kind: down ? 'ins' : 'del' });
    x = prevX;
    y = prevY;
  }
  edits.reverse();
  // Consecutive edits (no equal token between) make one hunk.
  const hunks: { aFrom: number; aTo: number; bFrom: number; bTo: number }[] = [];
  for (const edit of edits) {
    const last = hunks[hunks.length - 1];
    const aAt = edit.a;
    const bAt = edit.b;
    if (last && last.aTo === aAt && last.bTo === bAt) {
      if (edit.kind === 'del') last.aTo += 1;
      else last.bTo += 1;
    } else {
      hunks.push(edit.kind === 'del' ? { aFrom: aAt, aTo: aAt + 1, bFrom: bAt, bTo: bAt } : { aFrom: aAt, aTo: aAt, bFrom: bAt, bTo: bAt + 1 });
    }
  }
  return hunks;
}

function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** The hunks turning `base` into `next`: lines first, then letters within each changed block of lines. */
export function diffHunks(base: string, next: string): Hunk[] {
  let start = 0;
  while (start < base.length && start < next.length && base[start] === next[start]) start += 1;
  let endBase = base.length;
  let endNext = next.length;
  while (endBase > start && endNext > start && base[endBase - 1] === next[endNext - 1]) {
    endBase -= 1;
    endNext -= 1;
  }
  if (start === endBase && start === endNext) return [];
  const a = base.slice(start, endBase);
  const b = next.slice(start, endNext);
  const aLines = linesOf(a);
  const bLines = linesOf(b);
  const lineHunks = myers(aLines, bLines, MAX_LINE_EDITS) ?? [{ aFrom: 0, aTo: aLines.length, bFrom: 0, bTo: bLines.length }];
  const aAt = offsetsOf(aLines);
  const hunks: Hunk[] = [];
  for (const block of lineHunks) {
    const aFrom = aAt[block.aFrom]!;
    const aText = aLines.slice(block.aFrom, block.aTo).join('');
    const bText = bLines.slice(block.bFrom, block.bTo).join('');
    const letters = myers([...aText], [...bText], MAX_LETTER_EDITS);
    if (!letters) {
      hunks.push({ from: start + aFrom, to: start + aFrom + aText.length, insert: bText });
      continue;
    }
    // Hunks over code points; the text is indexed in UTF-16 units.
    const aUnits = unitOffsets(aText);
    const bUnits = unitOffsets(bText);
    for (const h of letters) {
      hunks.push({
        from: start + aFrom + aUnits[h.aFrom]!,
        to: start + aFrom + aUnits[h.aTo]!,
        insert: bText.slice(bUnits[h.bFrom], bUnits[h.bTo]),
      });
    }
  }
  return settle(hunks, base);
}

/** How good a place for an edit's edge the boundary between `left` and `right` is (undefined: the text's own edge). */
function edgeScore(left: string | undefined, right: string | undefined): number {
  if (left === undefined || right === undefined) return 6;
  if (left === '\n' || right === '\n') return 5;
  if (/\s/.test(left) || /\s/.test(right)) return 3;
  if (/[^\p{L}\p{N}_]/u.test(left) || /[^\p{L}\p{N}_]/u.test(right)) return 2;
  return 0;
}

/**
 * A pure deletion or insertion can sit at several places with the same result (deleting «two » or «wo t» from
 * «one two three»). Which one matters once someone else changed the text too: the edit is slid along the equal text
 * around it to where its edges fall on word and line boundaries (ties: the rightmost), as a person would have made it.
 */
function settle(hunks: Hunk[], base: string): Hunk[] {
  return hunks.map((hunk, i) => {
    const lo = i > 0 ? hunks[i - 1]!.to : 0;
    const hi = i < hunks.length - 1 ? hunks[i + 1]!.from : base.length;
    if (hunk.insert === '' && hunk.to > hunk.from) {
      let { from, to } = hunk;
      while (from > lo && base[from - 1] === base[to - 1]) {
        from -= 1;
        to -= 1;
      }
      let best = { from, to, score: -1 };
      for (;;) {
        const score = edgeScore(base[from - 1], base[from]) + edgeScore(base[to - 1], base[to]);
        if (score >= best.score) best = { from, to, score };
        if (to >= hi || base[from] !== base[to]) break;
        from += 1;
        to += 1;
      }
      return { from: best.from, to: best.to, insert: '' };
    }
    if (hunk.from === hunk.to && hunk.insert !== '') {
      let at = hunk.from;
      let text = hunk.insert;
      while (at > lo && base[at - 1] === text[text.length - 1]) {
        text = base[at - 1] + text.slice(0, -1);
        at -= 1;
      }
      let best = { at, text, score: -1 };
      for (;;) {
        const score = edgeScore(base[at - 1], text[0]) + edgeScore(text[text.length - 1], base[at]);
        if (score >= best.score) best = { at, text, score };
        if (at >= hi || base[at] !== text[0]) break;
        text = text.slice(1) + base[at];
        at += 1;
      }
      return { from: best.at, to: best.at, insert: best.text };
    }
    return hunk;
  });
}

/** Where each line starts (and, last, where the text ends). */
function offsetsOf(lines: readonly string[]): number[] {
  const out = [0];
  for (const line of lines) out.push(out[out.length - 1]! + line.length);
  return out;
}

/** UTF-16 offset of each code point boundary. */
function unitOffsets(text: string): number[] {
  const out = [0];
  let at = 0;
  for (const ch of text) {
    at += ch.length;
    out.push(at);
  }
  return out;
}

/** Was this (already split) item visible when `snapshot` was taken? */
function visibleIn(item: Y.Item, snapshot: Y.Snapshot): boolean {
  return (snapshot.sv.get(item.id.client) ?? 0) > item.id.clock && !Y.isDeleted(snapshot.ds, item.id);
}

/**
 * Applies `base → next` (base = the text when `snapshot` was taken) to `text` as it is now. The caller checked that
 * the snapshot is of this very replica.
 *
 * `marks` are positions in `next` (a caret, `gugu.bind.text`): they come back as positions in the text as it is
 * after — past what others added before them, and at the end of what this change put in (摩擦单 F59 → bind.text).
 */
export function applyFromSnapshot(text: Y.Text, snapshot: Y.Snapshot, base: string, next: string, marks: readonly number[] = []): number[] {
  const hunks = diffHunks(base, next);
  if (hunks.length === 0 && marks.length === 0) return [];
  const doc = text.doc!;
  let mapped: number[] = [];
  doc.transact((transaction) => {
    // Items cut exactly where the snapshot's state and deletions begin and end, so each is wholly visible in it or not
    // (what Yjs does itself before reading a type at a snapshot).
    snapshot.sv.forEach((clock, client) => {
      if (clock < Y.getState(doc.store, client)) Y.getItemCleanStart(transaction, Y.createID(client, clock));
    });
    Y.iterateDeletedStructs(transaction, snapshot.ds, () => {});

    // For each letter of the base: where it is now (-1: someone deleted it since), and where the text now is just
    // before it (`before[base.length]`: the end).
    const now = new Int32Array(base.length).fill(-1);
    const before = new Int32Array(base.length + 1);
    let at = 0;
    let current = 0;
    for (let item = text._start; item !== null; item = item.right) {
      if (!item.countable) continue;
      const wasThere = visibleIn(item, snapshot);
      const isThere = !item.deleted;
      if (wasThere) {
        for (let i = 0; i < item.length; i += 1) {
          before[at + i] = current + (isThere ? i : 0);
          if (isThere) now[at + i] = current + i;
        }
        at += item.length;
      }
      if (isThere) current += item.length;
    }
    before[base.length] = current;
    if (at !== base.length) throw new Error(`applyFrom: the snapshot spells ${at} letters, its text ${base.length}`);

    // From the last hunk back: what an earlier hunk touches sits before what a later one does, so positions hold.
    const removed = new Map<Hunk, number>();
    for (const hunk of [...hunks].reverse()) {
      let count = 0;
      // Deleted: only the base's own letters still there, in runs, right to left.
      let runEnd = -1;
      let runStart = -1;
      const flush = () => {
        if (runStart >= 0) {
          text.delete(runStart, runEnd - runStart);
          count += runEnd - runStart;
        }
        runStart = -1;
        runEnd = -1;
      };
      for (let j = hunk.to - 1; j >= hunk.from; j -= 1) {
        const index = now[j]!;
        if (index < 0) continue;
        if (runStart >= 0 && index === runStart - 1) runStart = index;
        else {
          flush();
          runStart = index;
          runEnd = index + 1;
        }
      }
      flush();
      removed.set(hunk, count);
      if (hunk.insert) text.insert(before[hunk.from]!, hunk.insert);
    }

    // A position in `next`: in what a hunk put in, it sits there; elsewhere just before the base letter it stood before.
    // Either way, what the earlier hunks changed moves it.
    mapped = marks.map((mark) => {
      let delta = 0; // next − base, over the hunks before
      let shift = 0; // now − before the change, over the hunks before
      for (const hunk of hunks) {
        const start = hunk.from + delta;
        if (mark < start) break;
        if (mark <= start + hunk.insert.length) return before[hunk.from]! + shift + (mark - start);
        delta += hunk.insert.length - (hunk.to - hunk.from);
        shift += hunk.insert.length - removed.get(hunk)!;
      }
      const at = Math.min(Math.max(mark - delta, 0), base.length);
      return before[at]! + shift;
    });
  });
  return mapped;
}

/**
 * base → mine and base → theirs, both kept: the rule the file service merges by, and the same code (`applyFrom`, F59) —
 * whatever the other side wrote stays, no letter of either is deleted and written back, and where both changed the same
 * text both are there. The editor merges a disk change into unsaved edits by it (摩擦单 F91).
 */
export function mergeThreeWay(base: string, mine: string, theirs: string): string {
  const doc = new Y.Doc({ gc: false });
  const text = doc.getText();
  text.insert(0, base);
  const snapshot = Y.snapshot(doc);
  applyFromSnapshot(text, snapshot, base, theirs);
  applyFromSnapshot(text, snapshot, base, mine);
  const merged = text.toString();
  doc.destroy();
  return merged;
}
