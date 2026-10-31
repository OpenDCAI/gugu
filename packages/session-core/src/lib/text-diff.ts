import type { SessionPatch } from '../acp/session-protocol';

/** Pure line diff shared by text-based ingress and display callers. */

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

/** Encode supplied bytes as one located file or an explicitly unlocated fragment. */
export function textFilePatch(path: string, before: string | null, after: string | null, scope: SessionPatch['scope'] = 'fragment'): SessionPatch & { type: 'diff' } {
  const lines = (value: string | null): string[] => value?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const aLines = lines(before);
  const bLines = lines(after);
  const a = JSON.stringify('a/' + path);
  const b = JSON.stringify('b/' + path);
  const body: string[] = [];
  for (const op of myersDiff(aLines, bLines)) {
    const line = op.op === 'insert' ? bLines[op.bIdx]! : aLines[op.aIdx]!;
    body.push((op.op === 'insert' ? '+' : op.op === 'delete' ? '-' : ' ') + (line.endsWith('\n') ? line.slice(0, -1) : line));
    if (!line.endsWith('\n')) body.push('\\ No newline at end of file');
  }
  const operation = before === null ? 'add' : after === null ? 'delete' : 'modify';
  const mode = operation === 'add' ? 'new file mode 100644\n' : operation === 'delete' ? 'deleted file mode 100644\n' : '';
  return {
    type: 'diff', changes: [{ operation, path }], scope: before === null || after === null ? 'file' : scope,
    patch: { format: 'git_patch', text: `diff --git ${a} ${b}\n${mode}--- ${before === null ? '/dev/null' : a}\n+++ ${after === null ? '/dev/null' : b}\n${body.length ? `@@ -${aLines.length ? 1 : 0},${aLines.length} +${bLines.length ? 1 : 0},${bLines.length} @@\n${body.join('\n')}\n` : ''}` },
  };
}
