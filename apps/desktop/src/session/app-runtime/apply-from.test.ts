import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyFromSnapshot, diffHunks } from './apply-from';
import { loadPage, until } from './fake-file-service';

/**
 * 摩擦单 F59 (L7-r, S12 round 6): an editor written in one sentence turns its whole view back into markdown and
 * diffs it against `f.text` by common prefix and suffix. While A was composing, B typed 15 letters on another line;
 * A's commit read 12 of them as «A deleted these», and they were gone on every side. `applyFrom(snapshot, next)` lands
 * only what changed since the snapshot, on the text as it is now.
 */

/** Two replicas that sync by hand; A is the one whose editor rewrites. */
function pair(initial: string) {
  const A = new Y.Doc();
  A.clientID = 1;
  A.getText('content').insert(0, initial);
  const B = new Y.Doc();
  B.clientID = 2;
  const sync = () => {
    Y.applyUpdate(B, Y.encodeStateAsUpdate(A, Y.encodeStateVector(B)));
    Y.applyUpdate(A, Y.encodeStateAsUpdate(B, Y.encodeStateVector(A)));
  };
  sync();
  return { A, B, a: A.getText('content'), b: B.getText('content'), sync };
}

/** What the editor did before (the control): one replacement between the common prefix and suffix of now and next. */
function prefixSuffixApply(text: Y.Text, next: string): void {
  const now = text.toString();
  let start = 0;
  while (start < now.length && start < next.length && now[start] === next[start]) start += 1;
  let endNow = now.length;
  let endNext = next.length;
  while (endNow > start && endNext > start && now[endNow - 1] === next[endNext - 1]) {
    endNow -= 1;
    endNext -= 1;
  }
  text.doc!.transact(() => {
    if (endNow > start) text.delete(start, endNow - start);
    if (endNext > start) text.insert(start, next.slice(start, endNext));
  });
}

const B_TYPED = 'fifteen letters'; // 15

/** B's letters still in the text, counted by who wrote them (Yjs identity), not by what they spell. */
function lettersBy(text: Y.Text, client: number): number {
  let count = 0;
  for (let item = text._start; item !== null; item = item.right) {
    if (item.countable && !item.deleted && item.id.client === client) count += item.length;
  }
  return count;
}

describe('applyFrom lands what changed since the snapshot (摩擦单 F59)', () => {
  it('L7 S12: B types 15 letters on another line while A composes — the prefix/suffix diff loses them; applyFrom loses none', () => {
    const base = '# Notes\nfirst line\nsecond line\n';
    const next = '# Notes\nfirst line!\nsecond line\n'; // A's commit, serialized from A's view
    const lost = (apply: (text: Y.Text, snapshot: Y.Snapshot) => void) => {
      const { A, a, b, sync } = pair(base);
      const snapshot = Y.snapshot(A);
      b.insert(base.indexOf(' line\n', base.indexOf('second')), B_TYPED);
      sync();
      apply(a, snapshot);
      sync();
      expect(a.toString()).toBe(b.toString()); // every side agrees on whatever came out
      return { lost: B_TYPED.length - lettersBy(a, 2), text: a.toString() };
    };
    // Control: the prefix/suffix diff against the live text deletes what B typed.
    expect(lost((a) => prefixSuffixApply(a, next)).lost).toBe(15);
    const fixed = lost((a, snapshot) => applyFromSnapshot(a, snapshot, base, next));
    expect(fixed.lost).toBe(0);
    expect(fixed.text).toBe(`# Notes\nfirst line!\nsecond${B_TYPED} line\n`);
  });

  it('someone changed the same line since the snapshot: both changes stay', () => {
    const base = 'hello world\n';
    const { A, a, b, sync } = pair(base);
    const snapshot = Y.snapshot(A);
    b.insert(6, 'big '); // B: hello big world
    sync();
    applyFromSnapshot(a, snapshot, base, 'hello there\n'); // A: world → there
    sync();
    expect(a.toString()).toBe('hello big there\n');
    expect(b.toString()).toBe('hello big there\n');
  });

  it('an empty file: the new text goes in, and what someone else put there meanwhile stays', () => {
    const { A, a, b, sync } = pair('');
    const snapshot = Y.snapshot(A);
    b.insert(0, 'x');
    sync();
    applyFromSnapshot(a, snapshot, '', 'hello');
    sync();
    expect(a.toString()).toBe('xhello');
    // Alone: just the new text.
    const alone = pair('');
    applyFromSnapshot(alone.a, Y.snapshot(alone.A), '', 'hello');
    expect(alone.a.toString()).toBe('hello');
  });

  it('what did not change is not touched: two separate lines change, and only their letters are deleted', () => {
    const base = 'a\nkeep this line\nc\n';
    const { A, a } = pair(base);
    const snapshot = Y.snapshot(A);
    let deleted = 0;
    A.on('update', (update: Uint8Array) => {
      for (const ranges of Y.decodeUpdate(update).ds.clients.values()) for (const range of ranges) deleted += range.len;
    });
    applyFromSnapshot(a, snapshot, base, 'A\nkeep this line\nC\n');
    expect(a.toString()).toBe('A\nkeep this line\nC\n');
    expect(deleted).toBe(2); // 'a' and 'c' — the line between is not deleted and written back
    expect(diffHunks(base, 'A\nkeep this line\nC\n')).toHaveLength(2);
  });

  it('a deletion of text someone already deleted is a no-op; letters they added inside it stay', () => {
    const base = 'one two three\n';
    const { A, a, b, sync } = pair(base);
    const snapshot = Y.snapshot(A);
    b.delete(4, 4); // B removed «two »
    b.insert(4, 'TWO '); // … and wrote «TWO »
    sync();
    applyFromSnapshot(a, snapshot, base, 'one three\n'); // A also removed «two »
    sync();
    expect(a.toString()).toBe('one TWO three\n');
  });
});

describe('applyFrom holds whatever the two sides did (seeded fuzz)', () => {
  let seed = 20260930;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (text: string) => text[Math.floor(random() * text.length)]!;
  const words = (n: number) => Array.from({ length: n }, () => Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick('abcdeéxyz*_#')).join('')).join(' ');
  /** A's editor: some lines rewritten, some removed, some added. */
  const rewrite = (text: string) =>
    text
      .split('\n')
      .flatMap((line) => {
        const r = random();
        if (r < 0.15) return [];
        if (r < 0.35) return [line.slice(0, Math.floor(random() * line.length)) + words(1) + line.slice(Math.floor(random() * line.length))];
        if (r < 0.45) return [line, words(2)];
        return [line];
      })
      .join('\n');

  it('B only adds: every letter B added survives, and both sides agree; alone, A gets exactly its text', () => {
    for (let round = 0; round < 300; round += 1) {
      const base = Array.from({ length: 1 + Math.floor(random() * 6) }, () => words(1 + Math.floor(random() * 5))).join('\n');
      const { A, a, b, sync } = pair(base);
      const snapshot = Y.snapshot(A);
      let added = 0;
      const typing = Math.floor(random() * 4);
      for (let i = 0; i < typing; i += 1) {
        const piece = words(1);
        b.insert(Math.floor(random() * (b.length + 1)), piece);
        added += piece.length;
      }
      sync();
      const next = rewrite(base);
      applyFromSnapshot(a, snapshot, base, next);
      sync();
      expect(a.toString()).toBe(b.toString());
      expect(lettersBy(a, 2)).toBe(added);
      if (typing === 0) expect(a.toString()).toBe(next);
    }
  });
});

describe('f.snapshot() / f.applyFrom() on an open file', () => {
  type TextFile = {
    text: string;
    saved: boolean;
    close(): void;
    snapshot(): { text: string };
    applyFrom(snapshot: { text: string }, next: string): void;
  };

  it('reaches the file service with the other person’s letters kept', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    service.write('item-1@1', '# Notes\nfirst line\nsecond line\n');
    const file = await open();
    await until(() => file.text.includes('second line'));
    const s = file.snapshot();
    service.insertAt('item-1@1', file.text.indexOf(' line\n', file.text.indexOf('second')), ` ${B_TYPED}`);
    await until(() => file.text.includes(B_TYPED));
    file.applyFrom(s, s.text.replace('first line', 'first line!'));
    await until(() => service.text('item-1@1').includes('first line!'));
    expect(service.text('item-1@1')).toBe(`# Notes\nfirst line!\nsecond ${B_TYPED} line\n`);
    await until(() => file.saved);
    file.close();
  });

  it('says so when handed something that is not its snapshot, or when closed', async () => {
    const { open } = await loadPage<TextFile>('text');
    const file = await open();
    expect(() => file.applyFrom({ text: '' }, 'x')).toThrow(expect.objectContaining({ code: 'invalid' }));
    const s = file.snapshot();
    file.close();
    expect(() => file.applyFrom(s, 'x')).toThrow(expect.objectContaining({ code: 'failed' }));
  });
});
