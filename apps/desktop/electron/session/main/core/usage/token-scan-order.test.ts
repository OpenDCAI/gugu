import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({
  reverse: false,
  waiting: new Map<string, () => void>(),
  completed: [] as string[],
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (path: string) => {
    const value = await actual.stat(path);
    const id = path.endsWith('parent.jsonl') ? 'parent' : 'child';
    await new Promise<void>((resolve) => {
      control.waiting.set(id, resolve);
      if (control.waiting.size === 2) {
        control.waiting.get(control.reverse ? 'child' : 'parent')!();
        setImmediate(() => {
          control.waiting.get(control.reverse ? 'parent' : 'child')!();
          control.waiting.clear();
        });
      }
    });
    control.completed.push(id);
    return value;
  } };
});

import { createIncrementalTokenFold } from './incremental-token-fold';
import { packParsedLogFile, type ParsedLogFile } from './token-log-file';
import { codexTokenReader } from './token-readers/codex';
import { collectTokenEntries, createParsedFileMemory, hydrateParsedFileMemory } from './token-scan';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('token scan locate precedence', () => {
  it('stat completion order does not invalidate an unchanged fork component or refold its entries', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gugu-token-order-'));
    const parent = join(dir, 'parent.jsonl'), child = join(dir, 'child.jsonl');
    const memory = createParsedFileMemory(), fold = createIncrementalTokenFold();
    const entry = { key: 'parent-key', legacyKey: 'request', ts: Date.parse('2026-11-01T00:00:00Z'),
      model: 'fixture', input: 3, output: 4, cacheRead: 5, cacheWrite: 6 };
    const parsed: ParsedLogFile[] = [
      { v: 2, offset: 20, state: { scope: 'parent' }, entries: [entry] },
      { v: 2, offset: 20, state: { scope: 'child', forkedFrom: 'parent' }, entries: [{ ...entry, key: 'child-key' }] },
    ];
    for (const [i, path] of [parent, child].entries()) {
      writeFileSync(path, ' '.repeat(19) + '\n');
      const info = statSync(path);
      hydrateParsedFileMemory(memory, [{ path, size: info.size, mtimeMs: Math.floor(info.mtimeMs), data: packParsedLogFile(parsed[i]) }]);
    }
    const scan = async () => {
      fold.begin({});
      const result = await collectTokenEntries({ providerSessions: ['parent', 'child'].map(providerSessionId => ({ provider: 'codex', providerSessionId })),
        readers: [{ ...codexTokenReader, locate: async () => new Map([['parent', [parent]], ['child', [child]]]) }],
        rootsByProvider: {}, memory, onSave: () => { throw new Error('Unchanged files must not be written'); }, onFile: file => fold.visit(file) });
      return { ...result, folded: fold.finish() };
    };
    control.reverse = false; control.completed = [];
    const first = await scan();
    expect(control.completed).toEqual(['parent', 'child']);
    const normalized = memory.normalized.get(child)!.entries;
    expect(normalized[0].key).toBe('parent-key');
    control.reverse = true; control.completed = [];
    const second = await scan();
    expect(control.completed).toEqual(['child', 'parent']);
    expect(second.stats).toMatchObject({ cacheHits: 2, bytesRead: 0 });
    expect(second.folded.rows).toEqual(first.folded.rows);
    expect(second.folded.processed).toBe(0);
    expect(memory.normalized.get(child)!.entries).toBe(normalized);
  });
});
