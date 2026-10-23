/**
 * 时间线存档：判据。
 *
 * 这一层是**性能捷径**，它的全部风险只有一条：接错了会拼出一份**缺了中间**的时间线，
 * 而那种缺失不报错、和「读得慢」在界面上分辨不出来（#5014）。所以这里的每条用例都不看
 * 「快不快」，只看**结果与整份重读是否逐字一致**，以及各种对不上时是否老老实实退回整份重读。
 *
 * 用真的 claude 记录源，❌ 不用假源：真正会咬人的是尾读器的字节偏移与分叉链判断，
 * 假源把这两样全绕过去了，测了等于没测。
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionTimeline } from './contract';
import { createClaudeJsonlSource } from './sources/claude-jsonl';
import { createSessionTimeline, TIMELINE_ARCHIVE_VERSION, type TimelineArchive } from './timeline';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/claude-session.jsonl', import.meta.url));
const PROVIDER_SESSION_ID = 'f1b2c3d4-0000-4000-8000-000000000001';
const SESSION_ID = 'conv-archive';

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function fixtureLines(): Promise<string[]> {
  return (await readFile(FIXTURE, 'utf8')).split('\n').filter((line) => line.trim());
}

/**
 * 每份记录钉在自己的根目录里。
 *
 * ⚠️ 这条不是洁癖：claude 记录源会沿**同目录**的分叉链往下走，两份记录共用一个目录时，
 * 「只放了前一半」的那份会顺着链把另一份的内容一并读进来 —— 于是不同长度的样本读出
 * 一模一样的结果，对照组就此失效（本轮实测踩过）。
 */
async function stage(lines: string[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'timeline-archive-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, '-work-repo');
  await mkdir(projectDir, { recursive: true });
  const file = join(projectDir, `${PROVIDER_SESSION_ID}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n');
  return { root, file };
}

async function open(root: string, archive?: TimelineArchive | null): Promise<SessionTimeline> {
  const source = createClaudeJsonlSource(
    { harness: 'claude', providerSessionId: PROVIDER_SESSION_ID, roots: [root] },
    { pollIntervalMs: 50 }
  );
  const timeline = await createSessionTimeline(source, {
    sessionId: SESSION_ID,
    archive
  });
  disposers.push(() => timeline.dispose());
  return timeline;
}

/**
 * 比对用的形状：去掉 seq。
 *
 * seq 是「发布到第几步」的计数，续读那条路上它本来就该和整份重读不同 —— 留着它比对，
 * 测的就成了计数器而不是内容。轮 id、条目 id、正文、顺序、状态才是判据。
 */
function shape(timeline: SessionTimeline): string {
  const turns = timeline.getSnapshot({ limit: 10_000 }).turns;
  return JSON.stringify(turns, (key, value) => (key === 'seq' ? undefined : value));
}

describe('时间线存档', () => {
  it('装回存档后只读增量，拼出来的时间线与整份重读逐字一致', async () => {
    const lines = await fixtureLines();
    const half = Math.max(1, Math.floor(lines.length / 2));

    // ① 冷开前一半 → 存档
    const first = await stage(lines.slice(0, half));
    const before = await open(first.root);
    before.syncPendingRequests([{ itemId: 'cache-witness', kind: 'permission', title: 'Cached approval', options: [] }]);
    before.settle({ itemId: 'cache-witness', optionId: 'allow', by: 'desktop' });
    const archive = await before.archive?.();
    expect(archive).toBeTruthy();
    before.dispose();

    // ② 记录又长出后一半（相当于「关掉一会儿，期间 agent 继续跑」）
    await appendFile(first.file, lines.slice(half).join('\n') + '\n');

    // ③ 带着存档重开 vs ④ 另起一份一模一样的记录整份冷读
    const resumed = await open(first.root, archive);
    const full = await open((await stage(lines)).root);

    expect(shape(resumed)).toBe(shape(full));
    // The host-only settlement cannot be rebuilt from native history: the cache really was reused.
    expect(resumed.getSnapshot().settlements).toContainEqual(expect.objectContaining({ itemId: 'cache-witness', state: 'resolved', optionId: 'allow' }));
    expect(full.getSnapshot().settlements.some(item => item.itemId === 'cache-witness')).toBe(false);
    expect(resumed.epoch).not.toBe(archive!.epoch);
  });

  it.each([1, 2, 3, TIMELINE_ARCHIVE_VERSION + 1])('rejects archive version %s and rebuilds from native history', async (version) => {
    const lines = await fixtureLines();
    const staged = await stage(lines);
    const before = await open(staged.root);
    const archive = await before.archive?.();
    before.dispose();

    const stale = { ...archive!, version } as TimelineArchive;
    const reopened = await open(staged.root, stale);
    const full = await open((await stage(lines)).root);

    expect(shape(reopened)).toBe(shape(full));
    expect(reopened.epoch).not.toBe(archive!.epoch);
    const rebuilt = await reopened.archive?.();
    expect(rebuilt?.version).toBe(TIMELINE_ARCHIVE_VERSION);
    const resumed = await open(staged.root, rebuilt);
    expect(resumed.epoch).not.toBe(rebuilt!.epoch);
    expect(shape(resumed)).toBe(shape(full));
  });

  it('记录被改写后不拿旧偏移量往下接，整份重放而不是缺一段', async () => {
    const lines = await fixtureLines();
    const half = Math.max(1, Math.floor(lines.length / 2));
    const staged = await stage(lines.slice(0, half));
    const before = await open(staged.root);
    const archive = await before.archive?.();
    before.dispose();

    // 整份换掉（重写而不是追加）：偏移量还指得到，但指向的已经不是同一份历史了。
    await writeFile(staged.file, lines.join('\n') + '\n');

    const reopened = await open(staged.root, archive);
    const full = await open((await stage(lines)).root);

    expect(shape(reopened)).toBe(shape(full));
  });

  it('reuses the archive contents but resets a client from the previous publisher', async () => {
    const lines = await fixtureLines();
    const half = Math.max(1, Math.floor(lines.length / 2));
    const staged = await stage(lines.slice(0, half));
    const before = await open(staged.root);
    const cursor = before.getSnapshot().cursor;
    const archive = await before.archive?.();
    before.dispose();

    await appendFile(staged.file, lines.slice(half).join('\n') + '\n');
    const resumed = await open(staged.root, archive);

    const after = resumed.getAfter(cursor);
    expect(after.ok).toBe(false);
    if (after.ok) throw new Error('a previous publisher cursor must reset');
    expect(after.reset).toBe('epoch_changed');
    expect(after.snapshot.turns).toEqual(resumed.getSnapshot().turns);
    expect(after.snapshot.cursor.epoch).not.toBe(cursor.epoch);
  });

  it('记录被截短（inode 没换、只是变短）→ 同样整份重放，❌ 不许拿旧偏移量往下读', async () => {
    // 与上一条只差**一个自由度**：那条是"重写成更长"，这条是"截短"。
    // 分开测是因为两者走的是尾读器里不同的判定分支（`info.size < offset` 才是截断那一支）。
    const lines = await fixtureLines();
    const staged = await stage(lines);
    const before = await open(staged.root);
    const archive = await before.archive?.();
    before.dispose();

    const half = Math.max(1, Math.floor(lines.length / 2));
    await writeFile(staged.file, lines.slice(0, half).join('\n') + '\n');

    const reopened = await open(staged.root, archive);
    const full = await open((await stage(lines.slice(0, half))).root);
    expect(shape(reopened)).toBe(shape(full));
  });

  it('续读没有把已经读过的再演一遍（轮数与整份重读相同）', async () => {
    // `shape` 相等其实已经含着这条,但轮数是**独立的一个读数**:
    // 万一将来 shape 的比对口径被放松,重复轮次这种最难看的坏法仍然有人守着。
    const lines = await fixtureLines();
    const half = Math.max(1, Math.floor(lines.length / 2));
    const staged = await stage(lines.slice(0, half));
    const before = await open(staged.root);
    const archive = await before.archive?.();
    before.dispose();
    await appendFile(staged.file, lines.slice(half).join('\n') + '\n');

    const resumed = await open(staged.root, archive);
    const full = await open((await stage(lines)).root);
    expect(resumed.getSnapshot({ limit: 10_000 }).turns.length).toBe(
      full.getSnapshot({ limit: 10_000 }).turns.length
    );
  });

  it('多字节字符跨读块时续读点仍落在行边界 —— ❌ 不许生出替换字符', async () => {
    // 续读点是**字节**偏移，而解码是按字符走的：按字符数推进偏移量，
    // 一行中文就能把它算短三分之二，下次从半个字符中间开读 → 正文里凭空多出 `\uFFFD`。
    // 全中文正文把这条差异放到最大。
    const lines = await fixtureLines();
    const wide = JSON.stringify({
      uuid: 'wide-0001',
      type: 'user',
      timestamp: '2026-09-09T00:00:00.000Z',
      message: { content: '中文'.repeat(3000) }
    });
    const staged = await stage([...lines, wide]);
    const before = await open(staged.root);
    const archive = await before.archive?.();
    before.dispose();

    const tail = JSON.stringify({
      uuid: 'wide-0002',
      type: 'assistant',
      timestamp: '2026-09-09T00:00:01.000Z',
      message: { id: 'wide-0002', content: [{ type: 'text', text: '后一句' }], stop_reason: 'end_turn' }
    });
    await appendFile(staged.file, tail + '\n');

    const resumed = await open(staged.root, archive);
    const text = JSON.stringify(resumed.getSnapshot({ limit: 10_000 }).turns);
    expect(text).toContain('后一句');
    expect(text).not.toContain('\uFFFD');
  });
});
