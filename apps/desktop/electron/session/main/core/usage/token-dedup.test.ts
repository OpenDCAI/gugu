import { describe, expect, it } from 'vitest';
import { foldTokenEntries } from './token-fold';
import { canonicalizeCodexForks } from './token-forks';
import type { ParsedLogFile } from './token-log-file';
import { claudeTokenReader } from './token-readers/claude';
import { codexTokenReader } from './token-readers/codex';
import type { TokenEntry } from './token-readers/types';
import type { ProviderTokenEntry } from './token-scan';

const ts = Date.parse('2026-11-05T12:00:00Z');
const entry = (changes: Partial<ProviderTokenEntry> = {}): ProviderTokenEntry => ({
  key: 'claude:m:r', ts, model: 'model', provider: 'claude', providerSessionId: 's',
  input: 10, output: 1, cacheRead: 20, cacheWrite: 30, quality: { complete: false, fields: 4 }, ...changes,
});

describe('whole-request Claude deduplication', () => {
  it('prefers a completed record even when a partial record has a larger total', () => {
    const partial = entry({ input: 1000, output: 300, cacheRead: 0, cacheWrite: 0 });
    const complete = entry({ output: 20, quality: { complete: true, fields: 4 } });
    for (const inputs of [[partial, complete], [complete, partial]]) {
      expect(foldTokenEntries(inputs)).toEqual([expect.objectContaining({ input: 10, output: 20, cacheRead: 20, cacheWrite: 30 })]);
    }
  });

  it('keeps billable incomplete records and prefers the more complete output snapshot', () => {
    expect(foldTokenEntries([entry(), entry({ output: 19 })])[0].output).toBe(19);
    expect(foldTokenEntries([entry()])[0].output).toBe(1);
  });

  it('uses field completeness and total only after completion and output, without mixing buckets', () => {
    const sparse = entry({ input: 999, cacheRead: 0, cacheWrite: 0, quality: { complete: true, fields: 2 } });
    const full = entry({ quality: { complete: true, fields: 4 } });
    const fuller = entry({ input: 8, cacheRead: 40, quality: { complete: true, fields: 4 } });
    expect(foldTokenEntries([sparse, full, fuller])[0]).toMatchObject({ input: 8, output: 1, cacheRead: 40, cacheWrite: 30 });
  });

  it('attributes the selected whole record to its actual model and session source', () => {
    const complete = entry({ model: 'final-model', providerSessionId: 'final', quality: { complete: true, fields: 4 } });
    expect(foldTokenEntries([entry(), complete], { final: { fallback: 'byok', spans: [] } })[0]).toMatchObject({ model: 'final-model', source: 'byok' });
  });

  it('preserves first-wins for retained legacy history with no quality metadata', () => {
    const a = entry({ quality: undefined });
    expect(foldTokenEntries([a, { ...a, output: 50 }])[0].output).toBe(1);
  });

  it('does not collapse different request IDs or providers', () => {
    const rows = foldTokenEntries([entry(), entry({ key: 'claude:m:other', output: 2 }), entry({ provider: 'other', output: 3 })]);
    expect(rows.map(r => r.output)).toEqual([3, 3]);
  });

  it.each([null, '', ' ', undefined])('does not treat stop_reason=%s as completed', stop => {
    const result = claudeTokenReader.readLine({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: 'r',
      message: { id: 'm', stop_reason: stop, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: NaN } } }, null);
    expect(result?.quality).toEqual({ complete: false, fields: 2 });
  });
});

function count(input: number, output = 10): Record<string, unknown> {
  return { type: 'event_msg', timestamp: new Date(ts).toISOString(), payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 0, total_tokens: input + output },
  } } };
}
function readCodex(scope: string, input = 100): TokenEntry {
  const state = codexTokenReader.initialState({ path: `/fixture/${scope}`, providerSessionId: scope });
  return codexTokenReader.readLine(count(input), state)!;
}
function file(scope: string, entries: TokenEntry[], parent?: string, path = scope): { path: string; parsed: ParsedLogFile } {
  return { path, parsed: { v: 2, offset: 0, state: { scope, ...(parent ? { forkedFrom: parent } : {}) }, entries } };
}
const event = (scope: string, n: number): TokenEntry => ({ ...readCodex(scope, n * 100), key: `${scope}:${n}`, legacyKey: `event:${n}`, ts: ts + n });

describe('Codex session identity and explicit fork copies', () => {
  it('counts unrelated sessions with the same timestamp and cumulative values separately', () => {
    const a = readCodex('a'), b = readCodex('b');
    expect(a.key).not.toBe(b.key);
    expect(a.legacyKey).toBe(b.legacyKey);
    expect(foldTokenEntries([a, b].map((e, i) => ({ ...e, provider: 'codex', providerSessionId: String(i) })))[0].output).toBe(20);
  });

  it('falls back to distinct file identities without a session id', () => {
    const keys = ['/one', '/two'].map(path => codexTokenReader.readLine(count(100), codexTokenReader.initialState({ path }))!.key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('does not let copied metadata override distinct caller session identities', () => {
    const keys = ['a', 'b'].map(providerSessionId => {
      const state = codexTokenReader.initialState({ path: `/fixture/${providerSessionId}`, providerSessionId });
      codexTokenReader.readLine({ type: 'session_meta', payload: { id: 'copied-parent' } }, state);
      return codexTokenReader.readLine(count(100), state)!.key;
    });
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses native session metadata and carries it through incremental state', () => {
    const state = codexTokenReader.initialState({ path: '/fixture' });
    expect(codexTokenReader.mayCarryUsage('{"type":"session_meta"}')).toBe(true);
    codexTokenReader.readLine({ type: 'session_meta', payload: { id: 'child', forked_from_id: 'parent' } }, state);
    const first = codexTokenReader.readLine(count(100), state)!;
    const cloned = structuredClone(state);
    const next = codexTokenReader.readLine(count(200, 20), cloned)!;
    expect(first.key).toContain('codex:scope:child:');
    expect(cloned).toMatchObject({ scope: 'child', forkedFrom: 'parent' });
    expect(next.output).toBe(10);
  });

  it('keeps distinct cumulative vectors when timestamp and total happen to match', () => {
    const state = codexTokenReader.initialState({ path: '/fixture', providerSessionId: 'one' });
    const a = codexTokenReader.readLine(count(100, 10), state)!;
    const b = codexTokenReader.readLine(count(90, 20), state)!;
    expect(a.legacyKey).toBe(b.legacyKey);
    expect(a.key).not.toBe(b.key);
  });

  it('deduplicates only an identical prefix of a located, explicit parent', () => {
    const parent = file('parent', [event('parent', 1), event('parent', 2)]);
    const child = file('child', [event('child', 1), event('child', 2), event('child', 3)], 'parent');
    for (const files of [[parent, child], [child, parent]]) {
      expect(canonicalizeCodexForks(files).get('child')!.map(e => e.key)).toEqual(['parent:1', 'parent:2', 'child:3']);
    }
  });

  it('stops at the first divergence and does not deduplicate later coincidences', () => {
    const parent = file('p', [event('p', 1), event('p', 2), event('p', 3)]);
    const child = file('c', [event('c', 1), { ...event('c', 2), output: 99 }, event('c', 3)], 'p');
    expect(canonicalizeCodexForks([parent, child]).get('c')!.map(e => e.key)).toEqual(['p:1', 'c:2', 'c:3']);
  });

  it('does not infer a parent from matching timestamps without explicit lineage', () => {
    const parent = file('p', [event('p', 1)]), child = file('c', [event('c', 1)]);
    expect(canonicalizeCodexForks([parent, child]).get('c')![0].key).toBe('c:1');
    expect(canonicalizeCodexForks([file('missing', [event('missing', 1)], 'absent')]).get('missing')![0].key).toBe('missing:1');
  });

  it('resolves a grandchild against the original parent', () => {
    const p = file('p', [event('p', 1)]), c = file('c', [event('c', 1), event('c', 2)], 'p');
    const g = file('g', [event('g', 1), event('g', 2), event('g', 3)], 'c');
    expect(canonicalizeCodexForks([g, c, p]).get('g')!.map(e => e.key)).toEqual(['p:1', 'c:2', 'g:3']);
  });

  it('leaves cycles untouched', () => {
    const a = file('a', [event('a', 1)], 'b'), b = file('b', [event('b', 1)], 'a');
    const result = canonicalizeCodexForks([a, b]);
    expect(result.get('a')![0].key).toBe('a:1');
    expect(result.get('b')![0].key).toBe('b:1');
  });

  it('uses compatible duplicate parent files but refuses ambiguous parent histories', () => {
    const short = file('p', [event('p', 1)], undefined, 'short');
    const long = file('p', [event('p', 1), event('p', 2)], undefined, 'long');
    const child = file('c', [event('c', 1), event('c', 2)], 'p');
    expect(canonicalizeCodexForks([short, long, child]).get('c')!.map(e => e.key)).toEqual(['p:1', 'p:2']);
    const conflicting = file('p', [{ ...event('p', 1), output: 999 }], undefined, 'conflict');
    expect(canonicalizeCodexForks([long, conflicting, child]).get('c')!.map(e => e.key)).toEqual(['c:1', 'c:2']);
  });
});
