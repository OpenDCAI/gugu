import { describe, expect, it } from 'vitest';
import { createIncrementalTokenFold, type TokenFileUpdate } from './incremental-token-fold';
import { foldTokenEntries, type TokenDayRow } from './token-fold';
import type { SourceSpans } from './model-source';
import type { TokenEntry } from './token-readers/types';

const entry = (key: string, input = 10): TokenEntry => ({ key, ts: Date.parse('2026-09-23T10:00:00Z'), model: 'model', input, output: 2, cacheRead: 30, cacheWrite: 4 });
const file = (path: string, entries: TokenEntry[], provider = 'claude'): TokenFileUpdate => ({ path, provider, providerSessionId: path,
  parsed: { v: 1, offset: 0, state: null, entries }, added: entries, reset: true });
const sorted = (rows: TokenDayRow[]) => rows.map((r) => ({ ...r })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function rig() {
  const fold = createIncrementalTokenFold();
  return (files: TokenFileUpdate[], sources: Record<string, SourceSpans> = {}) => {
    fold.begin(sources);
    for (const value of files) fold.visit(value);
    const result = fold.finish();
    const reference = foldTokenEntries(files.flatMap((value) => value.parsed.entries.map((e) => ({ ...e, provider: value.provider, providerSessionId: value.providerSessionId }))), sources);
    expect(sorted(result.rows)).toEqual(sorted(reference));
    return result;
  };
}

describe('incremental token fold', () => {
  it('unchanged histories visit zero entries; append visits only new entries, preserving legacy first-wins', () => {
    const run = rig(), a = file('a', [entry('same'), entry('same', 999), entry('two')]);
    const first = run([a]);
    a.reset = false; a.added = [];
    expect(run([a]).processed).toBe(0);
    const more = [entry('same', 500), entry('new')]; a.parsed.entries.push(...more); a.added = more;
    expect(run([a]).processed).toBe(2);
    expect(first.rows[0].input).toBe(20); // snapshots are not mutated by later updates
  });

  it('cross-file locate order, removal, reappearance and replacement retain oracle totals', () => {
    const run = rig(), a = file('a', [entry('copy', 10)]), b = file('b', [entry('copy', 90)]);
    run([a, b]); a.reset = b.reset = false; a.added = b.added = [];
    expect(run([b, a]).rows[0].input).toBe(90);
    expect(run([a]).rows[0].input).toBe(10);
    run([a, b]);
    const replacement = file('a', [entry('different', 5)]);
    run([replacement, b]);
    expect(run([]).rows).toEqual([]);
  });

  it('an appended key in an earlier file supersedes a later-file copy, without changing the reader key', () => {
    const run = rig(), a = file('a', [entry('first')]), b = file('b', [entry('copy', 90)]);
    run([a, b]); a.reset = b.reset = false; b.added = [];
    a.added = [entry('copy', 10)]; a.parsed.entries.push(...a.added);
    expect(run([a, b]).rows[0].input).toBe(20);
  });

  it('source reclassification only changes the winning session; provider namespaces remain separate', () => {
    const run = rig(), a = file('a', [entry('copy')]), b = file('b', [entry('copy', 90)]), c = file('c', [entry('copy', 50)], 'codex');
    run([a, b, c]);
    for (const value of [a, b, c]) { value.reset = false; value.added = []; }
    run([a, b, c], { a: { fallback: 'gugu', spans: [] }, b: { fallback: 'byok', spans: [] } });
    run([b, a, c], { a: { fallback: 'gugu', spans: [] }, b: { fallback: 'byok', spans: [] } });
    run([b, a, c]);
  });

  it('mixed append, truncate, scope, order and source changes agree with full fold over 100 rounds', () => {
    const run = rig(); const files = Array.from({ length: 4 }, (_, i) => file(String(i), [entry('shared', i + 1)]));
    for (let round = 0; round < 100; round += 1) {
      for (const value of files) { value.reset = false; value.added = []; }
      if (round % 9 === 0) files[round % 4] = file(String(round % 4), [entry('reset-' + round)]);
      else { const target = files[round % 4]; target.added = [entry('key-' + round % 7, round)]; target.parsed.entries.push(...target.added); }
      const order = round % 2 ? [...files].reverse() : [...files];
      run(round % 5 ? order : order.slice(1), { '1': { fallback: round % 3 ? 'gugu' : 'byok', spans: [] } });
    }
  });
  it('matches 1914 for mixed legacy and qualified snapshots, whole buckets and tie precedence', () => {
    const run = rig();
    const quality = (output: number, complete = true, fields = 4): TokenEntry => ({ ...entry('shared', 20 - output), output,
      cacheRead: output * 10, cacheWrite: output + 1, quality: { complete, fields } });
    const a = file('a', [quality(2, false)]), b = file('b', [entry('shared', 999), quality(8)]);
    expect(run([a, b]).rows[0]).toMatchObject({ input: 12, output: 8, cacheRead: 80, cacheWrite: 9 });
    a.reset = b.reset = false; a.added = b.added = [];
    // Reordering makes an unqualified legacy snapshot first and locks the key.
    expect(run([b, a]).rows[0].input).toBe(999);
    run([a, b]);
    a.added = [quality(10)]; a.parsed.entries.push(...a.added);
    expect(run([a, b]).rows[0].output).toBe(10);
    a.added = []; b.added = [quality(10)]; b.parsed.entries.push(...b.added);
    run([a, b], { a: { fallback: 'gugu', spans: [] }, b: { fallback: 'byok', spans: [] } });
    expect(run([b, a]).rows[0].input).toBe(999);
  });

  it('agrees field-by-field with the 1914 full fold across 400 mixed-quality updates', () => {
    const run = rig(), files = Array.from({ length: 5 }, (_, i) => file(String(i), []));
    let random = 1729;
    const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
    for (let round = 0; round < 400; round += 1) {
      for (const value of files) { value.reset = false; value.added = []; }
      const index = next() % files.length;
      const token = { ...entry('key-' + next() % 12, next() % 900), output: next() % 30,
        ts: Date.parse('2026-09-23T10:00:00Z') + (next() % 3) * 86400000,
        model: 'model-' + next() % 2,
        ...(next() % 4 ? { quality: { complete: !!(next() % 2), fields: next() % 5 } } : {}) };
      if (round % 17 === 0) files[index] = file(String(index), [token]);
      else { files[index].added = [token]; files[index].parsed.entries.push(token); }
      const ordered = round % 2 ? [...files].reverse() : files;
      run(round % 7 ? ordered : ordered.slice(1), { '1': { fallback: round % 3 ? 'gugu' : 'byok', spans: [] } });
    }
  });

  it('changing the local time zone reclassifies existing timestamps once', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const run = rig(), a = file('a', [{ ...entry('late'), ts: Date.parse('2026-09-23T23:30:00Z') }]);
      expect(run([a]).rows[0].day).toBe('2026-09-23');
      a.reset = false; a.added = []; process.env.TZ = 'Asia/Tokyo';
      expect(run([a]).rows[0].day).toBe('2026-09-24');
      expect(run([a]).processed).toBe(0);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });


});
