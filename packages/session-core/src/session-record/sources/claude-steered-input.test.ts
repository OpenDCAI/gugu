import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TranscriptTurn } from '../../acp/models/turns';
import { collectItems } from '../test-support';
import { createSessionTimeline } from '../timeline';
import { createClaudeJsonlSource } from './claude-jsonl';

// Reduced from Claude 2.1.310 native history: two ordinarily queued turns, then one
// cycle with an inserted queued_command. Text, paths and identifiers are sanitized;
// record order, input kinds, tool results and native stop boundaries are preserved.
const FIXTURE = new URL('../__fixtures__/claude-steered-session.jsonl', import.meta.url);
const SESSION = 'claude-steered-session';
const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
});

async function stage() {
  const root = await mkdtemp(join(tmpdir(), 'claude-steered-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, `${SESSION}.jsonl`);
  const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n');
  const source = () => createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION, roots: [root] });
  return { file, lines, source };
}

function expectNativeTurns(turns: readonly TranscriptTurn[]) {
  expect(turns.map(turn => collectItems([turn]).flatMap(item => item.kind === 'message' && item.role === 'user' ? [item.text] : [])))
    .toEqual([['run the first queued job'], ['run the queued follow-up'], ['run the insert job', 'also print pwd']]);
  expect(turns.map(turn => turn.outcome)).toEqual(Array.from({ length: 3 }, () => ({ kind: 'done', reason: 'end_turn' })));
  const tools = collectItems([turns[2]]).filter(item => item.kind.endsWith('-tool-call'));
  expect(tools).toHaveLength(2);
  expect(tools).toEqual([expect.objectContaining({ status: 'done' }), expect.objectContaining({ status: 'done' })]);
}

describe('Claude native inserted input', () => {
  it.each(['cold', 'before-insert', 'after-insert'] as const)('keeps native turns when reopened %s', async mode => {
    const { file, lines, source } = await stage();
    const insert = lines.findIndex(line => JSON.parse(line).attachment?.type === 'queued_command');
    const cut = mode === 'cold' ? lines.length : insert + (mode === 'after-insert' ? 1 : 0);
    await writeFile(file, lines.slice(0, cut).join('\n') + '\n');
    let timeline = await createSessionTimeline(source(), { sessionId: SESSION });
    disposers.push(() => timeline.dispose());
    if (mode !== 'cold') {
      const archive = await timeline.archive!();
      expect(archive).not.toBeNull();
      timeline.dispose();
      await appendFile(file, lines.slice(cut).join('\n') + '\n');
      timeline = await createSessionTimeline(source(), { sessionId: SESSION, archive: archive! });
    }
    expectNativeTurns(timeline.getSnapshot().turns);
  });

  it('invalidates resume data from before the steering mapping', async () => {
    const { file, lines, source } = await stage();
    await writeFile(file, lines.join('\n') + '\n');
    const timeline = await createSessionTimeline(source(), { sessionId: SESSION });
    disposers.push(() => timeline.dispose());
    const archive = await timeline.archive!();
    expect(archive).not.toBeNull();
    timeline.dispose();
    const resumed = source();
    disposers.push(() => resumed.stop());
    const onReset = vi.fn();
    await resumed.start({ onEntries: () => {}, onReset }, {
      ...archive!.resume,
      data: { ...(archive!.resume.data as Record<string, unknown>), version: 3 }
    });
    expect(onReset).toHaveBeenCalledWith('source_replaced');
  });
});
