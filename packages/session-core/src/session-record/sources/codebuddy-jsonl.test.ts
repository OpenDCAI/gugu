import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordSource } from '../contract';
import { projectMessagePreview } from '../message-preview';
import { createSessionTimeline } from '../timeline';
import { boundaryEntries, collectItems, contentEntries } from '../test-support';
import { createCodebuddyJsonlSource } from './codebuddy-jsonl';
import { SessionRecordNotFoundError } from './shared';

/**
 * 照 mac1 上 CodeBuddy Code 2.179.3 的真记录(ACP 腿)搭的一份,人名、群、id、正文都换成占位，行的形状原样:
 * 首轮输入带着 CodeBuddy 的 `<system-reminder>` 与咕咕的 `<gugu_platform>`;第二轮是群里投来的一条，
 * 同一步先说一句再调两个工具(一个失败),再发消息、收尾;第三轮还在跑。夹着 session-meta / 快照 / 标题 /
 * summary / turn-metrics 这些不在链上的行。
 */
const FIXTURE = fileURLToPath(new URL('../__fixtures__/codebuddy-session.jsonl', import.meta.url));

type Row = { type: string; id?: string; sessionId?: string };

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function rows(): Promise<Row[]> {
  return (await readFile(FIXTURE, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Row);
}

/** 照 CodeBuddy 的布局摆一份:`<根>/projects/<工作目录改写>/<会话 id>.jsonl`;根给到 `projects` 那一层。 */
async function stage(): Promise<{ root: string; file: string; id: string }> {
  const id = (await rows())[0]!.sessionId!;
  const home = await mkdtemp(join(tmpdir(), 'codebuddy-record-'));
  disposers.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'projects');
  await mkdir(join(root, 'Users-someone-proj'), { recursive: true });
  const file = join(root, 'Users-someone-proj', `${id}.jsonl`);
  await copyFile(FIXTURE, file);
  return { root, file, id };
}

function collect(source: SessionRecordSource) {
  const entries: RecordEntry[] = [];
  const resets: string[] = [];
  disposers.push(() => source.stop());
  const started = source.start({ onEntries: (batch) => entries.push(...batch), onReset: (reason) => resets.push(reason) });
  return { entries, resets, started };
}

async function timelineOf(root: string, id: string) {
  const timeline = await createSessionTimeline(
    createCodebuddyJsonlSource({ harness: 'codebuddy', providerSessionId: id, roots: [root] }),
    { sessionId: 'conv-codebuddy' }
  );
  disposers.push(() => timeline.dispose());
  return timeline;
}

describe('codebuddy jsonl 记录源', () => {
  it('按会话 id 在各项目目录里找到文件;不在链上的行(meta、快照、标题、summary、turn-metrics)不出条目', async () => {
    const { root, id } = await stage();
    const { entries, started } = collect(
      createCodebuddyJsonlSource({ harness: 'codebuddy', providerSessionId: id, roots: [join(root, 'missing'), root] })
    );
    await started;
    const kinds = contentEntries(entries).map((entry) => entry.event.kind);
    expect(kinds).toEqual(expect.arrayContaining(['message', 'thinking', 'tool_call', 'tool_update']));
    const offChain = new Set((await rows()).filter((row) => !['message', 'reasoning', 'function_call', 'function_call_result'].includes(row.type)).map((row) => row.id));
    expect(offChain.size).toBeGreaterThan(0);
    for (const entry of entries) expect(offChain.has(entry.key.slice('codebuddy:'.length).split('#')[0])).toBe(false);
  });

  it('首轮输入只留人说的那句:CodeBuddy 的 system-reminder 和咕咕的会话级背景不当人话', async () => {
    const { root, id } = await stage();
    const { entries, started } = collect(createCodebuddyJsonlSource({ harness: 'codebuddy', providerSessionId: id, roots: [root] }));
    await started;
    const said = contentEntries(entries).flatMap((entry) =>
      entry.event.kind === 'message' && entry.event.role === 'user' ? [entry.event.text] : []);
    expect(said[0]).toBe('hi');
    expect(said.join('\n')).not.toMatch(/<system-reminder|<gugu_platform/);
  });

  it('一步的最后一条是带 usage 的正文才收尾;先说话再调工具的那句不收', async () => {
    const { root, id } = await stage();
    const { entries, started } = collect(createCodebuddyJsonlSource({ harness: 'codebuddy', providerSessionId: id, roots: [root] }));
    await started;
    expect(boundaryEntries(entries).map((entry) => entry.boundary)).toEqual([
      { kind: 'turn_end', stopReason: 'end_turn', messageId: 's1' },
      { kind: 'turn_end', stopReason: 'end_turn', messageId: 's4' },
    ]);
  });

  it('接到时间线上:两轮做完、第三轮在跑;工具成功 / 失败折进工具行,发消息回执认得出消息 id', async () => {
    const { root, id } = await stage();
    const turns = (await timelineOf(root, id)).getSnapshot().turns;
    expect(turns.map((turn) => turn.outcome?.kind ?? null)).toEqual(['done', 'done', null]);
    const tools = collectItems([turns[1]!]).filter((item) => item.kind.endsWith('-tool-call')) as Array<{ status: string; outputText?: string }>;
    expect(tools.map((tool) => tool.status)).toEqual(['done', 'error', 'done']);
    expect(tools[2]!.outputText).toBe('replied (id=msg:00000000-0000-4000-8000-0000000000b1)');
  });

  it('MessagePreview:悬浮卡拿到投递的消息 id 和 agent 的原话,❌「别处来的消息」+「做完了」', async () => {
    const { root, id } = await stage();
    const preview = projectMessagePreview((await timelineOf(root, id)).getSnapshot().turns);
    expect(preview).toMatchObject({ running: true, now: 'searching', ended: null });
    expect(preview.entries.map(({ id: _id, ...entry }) => entry)).toEqual([
      { kind: 'tool', state: 'executing', count: 1 },
      { kind: 'tool', state: 'reading', count: 1 },
      { kind: 'tool', state: 'messaging', count: 1 },
      { kind: 'text', text: 'Replied in the group.', truncated: false, at: expect.any(Number) },
      { kind: 'prompt', messageId: 'msg:00000000-0000-4000-8000-0000000000a2' },
      { kind: 'tool', state: 'searching', count: 1 },
    ]);
  });

  it('尾读:接着链尾写的只发增量,收尾那条把在跑的一轮关上', async () => {
    const { root, file, id } = await stage();
    const timeline = await timelineOf(root, id);
    const leaf = (await rows()).filter((row) => row.type === 'function_call').at(-1)!;
    const line = (rowId: string, parentId: string, extra: Record<string, unknown>) =>
      JSON.stringify({ id: rowId, parentId, sessionId: id, timestamp: 1793793700000, ...extra });
    await appendFile(file, [
      line('tail-result', leaf.id!, { type: 'function_call_result', callId: 'call-4', name: 'Grep', status: 'completed', output: { type: 'text', text: 'none' } }),
      line('tail-answer', 'tail-result', { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '没找到' }], providerData: { messageId: 's6' }, message: { usage: { total_tokens: 1 } } }),
    ].join('\n') + '\n');
    await timeline.catchUp();
    const turns = timeline.getSnapshot().turns;
    expect(turns.at(-1)!.outcome?.kind).toBe('done');
    expect(projectMessagePreview(turns)).toMatchObject({ running: false, ended: { kind: 'done' } });
  });

  it('找不到就响亮地失败', async () => {
    const { root } = await stage();
    await expect(
      createCodebuddyJsonlSource({ harness: 'codebuddy', providerSessionId: 'nope', roots: [root] }).start({
        onEntries: () => {},
        onReset: () => {}
      })
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });
});
