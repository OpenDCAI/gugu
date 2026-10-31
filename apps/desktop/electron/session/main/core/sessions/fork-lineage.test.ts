import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeTranscriptDirFor,
  listSessionTranscripts,
  pickForkParent,
  readTranscriptHead,
  readTranscriptUuids,
  type ForkParentCandidate,
} from './fork-lineage';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

function candidate(
  sessionId: string,
  uuids: string[],
  lastInteractedAt: string | null = null
): ForkParentCandidate {
  return { sessionId, uuids: new Set(uuids), lastInteractedAt };
}

describe('claudeTranscriptDirFor', () => {
  it('slugs the workspace path with every non-alphanumeric char replaced by dashes', () => {
    const dir = claudeTranscriptDirFor('/root/gugu-main/.claude/worktrees/fork-share', {
      CLAUDE_CONFIG_DIR: '/cfg',
    } as NodeJS.ProcessEnv);
    expect(dir).toBe('/cfg/projects/-root-gugu-main--claude-worktrees-fork-share');
  });

  it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    const dir = claudeTranscriptDirFor('/tmp/x', {} as NodeJS.ProcessEnv);
    expect(dir).toMatch(/\.claude\/projects\/-tmp-x$/);
  });
});

describe('transcript listing and uuid reading', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'fork-lineage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists only uuid-named jsonl files and reads their message uuids', async () => {
    const lines = [
      JSON.stringify({ type: 'user', uuid: 'u1' }),
      JSON.stringify({ type: 'assistant', uuid: 'u2' }),
      JSON.stringify({ type: 'mode' }), // no uuid — ignored
      '{ partial trailing line',
    ].join('\n');
    await writeFile(path.join(dir, `${SESSION_A}.jsonl`), lines);
    await writeFile(path.join(dir, 'agent-notes.jsonl'), '{}'); // non-session file
    await writeFile(path.join(dir, 'readme.md'), 'x');

    const transcripts = await listSessionTranscripts(dir);
    expect(transcripts.map((t) => t.providerSessionId)).toEqual([SESSION_A]);

    const uuids = await readTranscriptUuids(transcripts[0]!.filePath);
    expect(uuids).toEqual(new Set(['u1', 'u2']));
  });

  it('returns an empty list for a missing dir (no claude sessions yet)', async () => {
    expect(await listSessionTranscripts(path.join(dir, 'nope'))).toEqual([]);
  });

  it('stops reading at the maxLines cap', async () => {
    const lines = ['u1', 'u2', 'u3']
      .map((uuid) => JSON.stringify({ type: 'user', uuid }))
      .join('\n');
    const filePath = path.join(dir, `${SESSION_B}.jsonl`);
    await writeFile(filePath, lines);
    expect(await readTranscriptUuids(filePath, 2)).toEqual(new Set(['u1', 'u2']));
  });
  it('reads the head up to the first message: root uuid, plus the SDK forkedFrom when present', async () => {
    const cliFork = path.join(dir, `${SESSION_A}.jsonl`);
    await writeFile(
      cliFork,
      [
        JSON.stringify({ type: 'mode', sessionId: SESSION_A }),
        JSON.stringify({ type: 'queue-operation', sessionId: SESSION_A }),
        JSON.stringify({ type: 'attachment', uuid: 'root', sessionId: SESSION_A }),
        JSON.stringify({ type: 'user', uuid: 'second', sessionId: SESSION_A }),
      ].join('\n')
    );
    expect(await readTranscriptHead(cliFork)).toEqual({ rootUuid: 'root', forkedFromProviderSessionId: null });

    const sdkFork = path.join(dir, `${SESSION_B}.jsonl`);
    await writeFile(
      sdkFork,
      JSON.stringify({ type: 'attachment', uuid: 'r2', forkedFrom: { sessionId: SESSION_A, messageUuid: 'x' } })
    );
    expect(await readTranscriptHead(sdkFork)).toEqual({ rootUuid: 'r2', forkedFromProviderSessionId: SESSION_A });
  });

  it('has no head until a message is written, and none for a missing file', async () => {
    const pending = path.join(dir, `${SESSION_A}.jsonl`);
    await writeFile(pending, `${JSON.stringify({ type: 'mode' })}\n{ "uuid": "half`);
    expect(await readTranscriptHead(pending)).toBeNull();
    expect(await readTranscriptHead(path.join(dir, 'gone.jsonl'))).toBeNull();
  });
});

describe('pickForkParent', () => {
  it('returns null when no candidate overlaps (ordinary external session)', () => {
    expect(pickForkParent(new Set(['x1', 'x2']), [candidate(SESSION_A, ['u1', 'u2'])])).toBeNull();
  });

  it('picks the candidate with the largest uuid overlap (direct parent over grandparent)', () => {
    const grandparent = candidate('gp', ['u1', 'u2']);
    const parent = candidate('p', ['u1', 'u2', 'u3', 'u4']);
    const child = new Set(['u1', 'u2', 'u3', 'u4', 'c1']);
    expect(pickForkParent(child, [grandparent, parent])).toBe(parent);
    expect(pickForkParent(child, [parent, grandparent])).toBe(parent);
  });

  it('breaks equal overlaps toward the most recently interacted candidate', () => {
    const older = candidate(SESSION_A, ['u1'], '2026-07-01T00:00:00Z');
    const newer = candidate(SESSION_B, ['u1'], '2026-07-20T00:00:00Z');
    expect(pickForkParent(new Set(['u1', 'c1']), [older, newer])).toBe(newer);
    expect(pickForkParent(new Set(['u1', 'c1']), [newer, older])).toBe(newer);
  });
});
