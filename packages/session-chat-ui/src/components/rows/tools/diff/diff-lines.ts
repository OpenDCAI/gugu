/**
 * diff-lines — pure line-level diff using the Myers algorithm.
 *
 * No external dependencies. Operates on the replaced region supplied by ACP
 * (`oldText` = old_string, `newText` = new_string), not on whole-file content.
 *
 * Public API:
 *   computeDiffRows(oldText, newText) — full interleaved row list, pure (no cache)
 *   countChanges(rows)               — adds + dels over the whole diff
 *   selectPreview(rows)              — window of ≤12 rows around the first change
 *
 * Memoization is handled by the per-instance ChatCaches bundle in core/caches.ts.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiffRowType = 'context' | 'add' | 'remove';

export type DiffRow = {
  type: DiffRowType;
  text: string;
  /** Index into the old lines array (present on 'context' and 'remove' rows). */
  oldIdx?: number;
  /** Index into the new lines array (present on 'context' and 'add' rows). */
  newIdx?: number;
};

// ── Myers diff ────────────────────────────────────────────────────────────────

/**
 * Myers shortest edit script over two string arrays, in linear space (the
 * paper's "middle snake" divide and conquer, §4b). Returns the operations that
 * turn `a` into `b`:
 *   'keep'   — line is equal (context)
 *   'insert' — line exists in `b` only (add)
 *   'delete' — line exists in `a` only (remove)
 *
 * @@@linear-space-myers — keeping a copy of the frontier for every edit step
 * (the textbook backtrack) costs edit-distance × total-lines memory: one
 * 4,000-line rewrite allocated ~1 GB and blocked the renderer ~4 s, and every
 * reseed of a transcript page recomputed it. Here only two frontiers live.
 */
type EditOp = { op: 'keep' | 'insert' | 'delete'; aIdx: number; bIdx: number };

function myersDiff(a: string[], b: string[]): EditOp[] {
  const ops: EditOp[] = [];
  const size = 2 * (a.length + b.length) + 4;
  const forward = new Int32Array(size);
  const backward = new Int32Array(size);

  // The furthest-reaching paths from both corners meet on one snake of a
  // shortest script; split there and solve each side the same way.
  const middleSnake = (aLo: number, aHi: number, bLo: number, bHi: number) => {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const delta = n - m;
    const odd = (delta & 1) !== 0;
    const off = n + m + 1;
    forward[off + 1] = 0;
    backward[off + 1] = 0;
    for (let d = 0; d <= Math.ceil((n + m) / 2); d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && forward[off + k - 1]! < forward[off + k + 1]!) ? forward[off + k + 1]! : forward[off + k - 1]! + 1;
        let y = x - k;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aLo + x] === b[bLo + y]) { x++; y++; }
        forward[off + k] = x;
        const c = delta - k;
        if (odd && c >= -(d - 1) && c <= d - 1 && x + backward[off + c]! >= n) return { x: x0, y: y0, u: x, v: y, d: 2 * d - 1 };
      }
      for (let c = -d; c <= d; c += 2) {
        let x = c === -d || (c !== d && backward[off + c - 1]! < backward[off + c + 1]!) ? backward[off + c + 1]! : backward[off + c - 1]! + 1;
        let y = x - c;
        const x0 = x;
        const y0 = y;
        while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) { x++; y++; }
        backward[off + c] = x;
        const k = delta - c;
        if (!odd && k >= -d && k <= d && x + forward[off + k]! >= n) return { x: n - x, y: m - y, u: n - x0, v: m - y0, d: 2 * d };
      }
    }
    throw new Error('myersDiff: paths never met');
  };

  const solve = (aLo: number, aHi: number, bLo: number, bHi: number): void => {
    // Equal ends are kept as they are; after trimming them, one side empty
    // means the rest is pure insertion or deletion.
    let head = 0;
    while (aLo + head < aHi && bLo + head < bHi && a[aLo + head] === b[bLo + head]) head++;
    let tail = 0;
    while (aHi - tail > aLo + head && bHi - tail > bLo + head && a[aHi - 1 - tail] === b[bHi - 1 - tail]) tail++;
    for (let i = 0; i < head; i++) ops.push({ op: 'keep', aIdx: aLo + i, bIdx: bLo + i });
    const aMid = aLo + head;
    const bMid = bLo + head;
    const aEnd = aHi - tail;
    const bEnd = bHi - tail;
    if (aMid === aEnd) for (let j = bMid; j < bEnd; j++) ops.push({ op: 'insert', aIdx: aMid, bIdx: j });
    else if (bMid === bEnd) for (let i = aMid; i < aEnd; i++) ops.push({ op: 'delete', aIdx: i, bIdx: bMid });
    else {
      const snake = middleSnake(aMid, aEnd, bMid, bEnd);
      solve(aMid, aMid + snake.x, bMid, bMid + snake.y);
      for (let i = snake.x; i < snake.u; i++) ops.push({ op: 'keep', aIdx: aMid + i, bIdx: bMid + snake.y + (i - snake.x) });
      solve(aMid + snake.u, aEnd, bMid + snake.v, bEnd);
    }
    for (let i = tail; i > 0; i--) ops.push({ op: 'keep', aIdx: aHi - i, bIdx: bHi - i });
  };

  solve(0, a.length, 0, b.length);
  return ops;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute a line-level diff between `oldText` and `newText`.
 *
 * When `oldText` is null (new file), every line in `newText` is an 'add' row.
 * Pure — no internal cache. Memoization lives in ChatCaches (core/caches.ts).
 */
export function computeDiffRows(oldText: string | null, newText: string): DiffRow[] {
  if (oldText === null) {
    return newText.split('\n').map((text, i) => ({ type: 'add' as const, text, newIdx: i }));
  }

  const aLines = oldText.split('\n');
  const bLines = newText.split('\n');
  const ops = myersDiff(aLines, bLines);

  return ops.map((op) => {
    if (op.op === 'keep') {
      return {
        type: 'context' as const,
        text: aLines[op.aIdx]!,
        oldIdx: op.aIdx,
        newIdx: op.bIdx,
      };
    }
    if (op.op === 'delete') {
      return { type: 'remove' as const, text: aLines[op.aIdx]!, oldIdx: op.aIdx };
    }
    return { type: 'add' as const, text: bLines[op.bIdx]!, newIdx: op.bIdx };
  });
}

/**
 * Count the total number of additions and deletions across a full diff.
 */
export function countChanges(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds++;
    else if (row.type === 'remove') dels++;
  }
  return { adds, dels };
}

/**
 * Select a preview window of `maxLines` rows anchored at the first changed line,
 * with `context` leading context lines before the first change.
 *
 * Returns an empty array when there are no changes.
 */
export function selectPreview(rows: DiffRow[], maxLines = 12, context = 1): DiffRow[] {
  const firstChange = rows.findIndex((r) => r.type !== 'context');
  if (firstChange === -1) return [];
  const start = Math.max(0, firstChange - context);
  return rows.slice(start, start + maxLines);
}
