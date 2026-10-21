import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordSource } from '../contract';
import { createSessionTimeline } from '../timeline';
import { boundaryEntries, contentEntries } from '../test-support';
import { createPiJsonlSource } from './pi-jsonl';
import { SessionRecordNotFoundError } from './shared';

/**
 * 两份 pi 真记录(本机 `~/.pi/agent/sessions`,pi 0.6x 写的),文本一律换成占位、结构原样:
 *  · aborted:三句用户话，中间那一轮被打断(`stopReason: aborted`),其间有工具调用(`toolUse`);
 *  · error:两轮，有一轮 `stopReason: error`。
 */
const fixture = (name: string) => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

type Line = { type: string; id: string; parentId?: string | null; message?: { role: string; stopReason?: string } };

async function lines(name: string): Promise<Line[]> {
  return (await readFile(fixture(name), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Line);
}

/** 照 pi 的布局摆一份:`<root>/--<cwd>--/<时间戳>_<id>.jsonl`。 */
async function stage(name: string): Promise<{ root: string; file: string; id: string }> {
  const header = (await lines(name))[0];
  const root = await mkdtemp(join(tmpdir(), 'pi-record-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '--work-proj--'));
  const file = join(root, '--work-proj--', `2026-08-28T06-16-23-489Z_${header.id}.jsonl`);
  await copyFile(fixture(name), file);
  return { root, file, id: header.id };
}

function collect(source: SessionRecordSource) {
  const entries: RecordEntry[] = [];
  const resets: string[] = [];
  disposers.push(() => source.stop());
  const started = source.start({ onEntries: (batch) => entries.push(...batch), onReset: (reason) => resets.push(reason) });
  return { entries, resets, started };
}

describe('pi jsonl 记录源', () => {
  it('ACP 腿记的是会话 id:在 sessions 根下按 `_<id>.jsonl` 找到文件', async () => {
    const { root, id } = await stage('pi-session-aborted.jsonl');
    const { entries, started } = collect(
      createPiJsonlSource({ harness: 'pi', providerSessionId: id, roots: [join(root, 'missing'), root] })
    );
    await started;
    const kinds = contentEntries(entries).map((entry) => entry.update.sessionUpdate);
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('agent_thought_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    for (const entry of entries) expect(entry.key.startsWith('pi:')).toBe(true);
  });

  it('终端腿记的是文件绝对路径:直接读它', async () => {
    const { file } = await stage('pi-session-aborted.jsonl');
    const { entries, started } = collect(createPiJsonlSource({ harness: 'pi', providerSessionId: file, roots: [] }));
    await started;
    expect(contentEntries(entries).length).toBeGreaterThan(0);
  });

  it('找不到就响亮地失败', async () => {
    const { root } = await stage('pi-session-aborted.jsonl');
    await expect(
      createPiJsonlSource({ harness: 'pi', providerSessionId: 'nope', roots: [root] }).start({
        onEntries: () => {},
        onReset: () => {}
      })
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
    await expect(
      createPiJsonlSource({ harness: 'pi', providerSessionId: join(root, 'gone.jsonl'), roots: [] }).start({
        onEntries: () => {},
        onReset: () => {}
      })
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('stopReason 出边界:toolUse 不是边界,aborted 是打断', async () => {
    const { root, id } = await stage('pi-session-aborted.jsonl');
    const assistants = (await lines('pi-session-aborted.jsonl'))
      .filter((line) => line.message?.role === 'assistant')
      .map((line) => line.message!.stopReason);
    // 对照:这份真记录里三种都有 —— 下面的边界数不是「每条 assistant 都出」恰好数对。
    expect(assistants).toContain('toolUse');
    expect(assistants).toContain('aborted');
    expect(assistants).toContain('stop');

    const { entries, started } = collect(createPiJsonlSource({ harness: 'pi', providerSessionId: id, roots: [root] }));
    await started;
    const bounds = boundaryEntries(entries).map((entry) => entry.boundary.kind);
    expect(bounds).toHaveLength(assistants.filter((reason) => reason !== 'toolUse').length);
    expect(bounds).toContain('turn_aborted');
  });

  it('带工具调用的 length 不是边界:pi 判这些调用失败、接着跑，这一轮由后面的 stop 关上', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-length-'));
    disposers.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'length.jsonl');
    const row = (id: string, parentId: string | null, message: Record<string, unknown>) =>
      JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-10-17T00:00:00.000Z', message });
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sess-len', timestamp: '2026-10-17T00:00:00.000Z', cwd: '/w' }),
        row('u1', null, { role: 'user', content: 'go' }),
        row('a1', 'u1', { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }], stopReason: 'length' }),
        row('r1', 'a1', { role: 'toolResult', toolCallId: 'call-1', content: 'truncated', isError: true }),
        row('a2', 'r1', { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' }),
      ].join('\n') + '\n'
    );
    const { entries, started } = collect(createPiJsonlSource({ harness: 'pi', providerSessionId: file, roots: [] }));
    await started;
    expect(boundaryEntries(entries).map((entry) => [entry.key, entry.boundary])).toEqual([
      ['pi:a2#end', { kind: 'turn_end', stopReason: 'end_turn' }],
    ]);
  });

  it('接到时间线上:被打断的那一轮是 cancelled,每一轮都有结局', async () => {
    const { root, id } = await stage('pi-session-aborted.jsonl');
    const timeline = await createSessionTimeline(
      createPiJsonlSource({ harness: 'pi', providerSessionId: id, roots: [root] }),
      { sessionId: 'conv-pi' }
    );
    disposers.push(() => timeline.dispose());
    const turns = timeline.getSnapshot().turns;
    expect(turns.length).toBeGreaterThan(1);
    // 这份记录里有两句用户话连着发(前一句还没回人又补了一句):前一句那一轮被后一句关掉，没有结局 ——
    // 那是 reducer 的既有规则，不是这里要判的。这里判：被打断的那轮是 cancelled,最后一轮不停在进行中。
    expect(turns.map((turn) => turn.outcome?.kind)).toContain('cancelled');
    expect(turns[turns.length - 1].outcome?.kind).toBe('done');
  });

  it('出错的那一轮是 error,不停在进行中', async () => {
    const { root, id } = await stage('pi-session-error.jsonl');
    const timeline = await createSessionTimeline(
      createPiJsonlSource({ harness: 'pi', providerSessionId: id, roots: [root] }),
      { sessionId: 'conv-pi-error' }
    );
    disposers.push(() => timeline.dispose());
    const turns = timeline.getSnapshot().turns;
    expect(turns.length).toBeGreaterThan(0);
    for (const turn of turns) expect(turn.outcome).toBeDefined();
    // 对照:样本里有一轮 stopReason=error,其余是 stop —— 不是「凡结局都成了 error」。
    expect(turns.map((turn) => turn.outcome?.kind)).toContain('error');
    expect(turns.map((turn) => turn.outcome?.kind)).toContain('done');
  });

  it('尾读：接着叶子写的只发增量;叶子跳回旧分支 ⇒ 整份重来，丢掉的分支不再出现', async () => {
    const { root, file, id } = await stage('pi-session-aborted.jsonl');
    const all = await lines('pi-session-aborted.jsonl');
    const tree = all.filter((line) => line.type !== 'session');
    const leaf = tree[tree.length - 1];
    const firstUser = tree.find((line) => line.message?.role === 'user')!;
    const source = createPiJsonlSource({ harness: 'pi', providerSessionId: id, roots: [root] }, { pollIntervalMs: 60_000 });
    const { entries, resets, started } = collect(source);
    await started;
    const before = entries.length;

    const userLine = (entryId: string, parentId: string, text: string) =>
      JSON.stringify({ type: 'message', id: entryId, parentId, timestamp: '2026-08-28T07:00:00.000Z', message: { role: 'user', content: text, timestamp: 1787900400000 } });

    await appendFile(file, `${userLine('tail0001', leaf.id, '接着说')}\n`);
    await source.catchUp?.();
    expect(resets).toEqual([]);
    expect(entries.slice(before).map((entry) => entry.key)).toEqual(['pi:tail0001#0']);

    // 回到第一句话之后另起一支:原来那一支(含刚才的 tail0001)不在新的叶子路径上。
    entries.length = 0;
    await appendFile(file, `${userLine('fork0001', firstUser.id, '换个思路')}\n`);
    await source.catchUp?.();
    expect(resets).toEqual(['source_replaced']);
    const keys = entries.map((entry) => entry.key);
    expect(keys).toContain('pi:fork0001#0');
    expect(keys).toContain(`pi:${firstUser.id}#0`);
    expect(keys).not.toContain('pi:tail0001#0');
    expect(keys).not.toContain(`pi:${leaf.id}#0`);
  });
});
