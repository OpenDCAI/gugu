import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordSource } from '../contract';
import { createSessionTimeline } from '../timeline';
import { boundaryEntries, collectItems, contentEntries } from '../test-support';
import { createQwenJsonlSource } from './qwen-jsonl';
import { SessionRecordNotFoundError } from './shared';

/**
 * mac1 上一份 qwen 真记录(ACP 腿，0.2x 写的),文本一律换成占位、结构原样:
 * 五句用户话，其中四轮以 `end_turn` 收尾(四条 branch_checkpoint);工具结果成功、出错、取消各一;
 * 中间夹着 ui_telemetry / file_history_snapshot 这些不是对话内容的系统行。
 */
const FIXTURE = fileURLToPath(new URL('../__fixtures__/qwen-session.jsonl', import.meta.url));

type Record_ = { type: string; subtype?: string; uuid: string; parentUuid: string | null; sessionId: string; provenance?: string };

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function records(): Promise<Record_[]> {
  return (await readFile(FIXTURE, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record_);
}

/** 照 qwen 的布局摆一份:`<root>/<工作目录改写>/chats/<会话 id>.jsonl`。 */
async function stage(): Promise<{ root: string; file: string; id: string }> {
  const id = (await records())[0].sessionId;
  const root = await mkdtemp(join(tmpdir(), 'qwen-record-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '-Users-someone-proj', 'chats'), { recursive: true });
  const file = join(root, '-Users-someone-proj', 'chats', `${id}.jsonl`);
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

describe('qwen jsonl 记录源', () => {
  it('按会话 id 在各项目目录的 chats/ 里找到文件，解出对话内容', async () => {
    const { root, id } = await stage();
    const { entries, started } = collect(
      createQwenJsonlSource({ harness: 'qwen', providerSessionId: id, roots: [join(root, 'missing'), root] })
    );
    await started;
    const kinds = contentEntries(entries).map((entry) => entry.update.sessionUpdate);
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('agent_thought_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    // 系统行(遥测、快照)不是对话内容：没有一条条目出自它们。
    const system = new Set((await records()).filter((r) => r.type === 'system' && r.subtype !== 'branch_checkpoint').map((r) => r.uuid));
    expect(system.size).toBeGreaterThan(0);
    for (const entry of entries) expect(system.has(entry.key.slice('qwen:'.length).split('#')[0])).toBe(false);
  });

  it('qwen 替人塞的用户行(provenance: system,通知 / 定时任务)不当人说的话', async () => {
    const { root, file, id } = await stage();
    const leaf = (await records()).at(-1)!;
    const line = (uuid: string, parentUuid: string, provenance: string, subtype?: string) =>
      JSON.stringify({ uuid, parentUuid, sessionId: id, timestamp: '2026-10-17T08:00:00.000Z', type: 'user', provenance, ...(subtype ? { subtype } : {}), message: { role: 'user', parts: [{ text: 'x' }] } });
    await appendFile(file, `${line('note-0001', leaf.uuid, 'system', 'notification')}\n${line('user-0001', 'note-0001', 'real_user')}\n`);
    const { entries, started } = collect(createQwenJsonlSource({ harness: 'qwen', providerSessionId: id, roots: [root] }));
    await started;
    const keys = entries.map((entry) => entry.key);
    // 对照:紧跟着的那句真用户话照常进来 —— 读到了追加的行，只是通知那一条被挡下。
    expect(keys).toContain('qwen:user-0001#0');
    expect(keys.some((key) => key.startsWith('qwen:note-0001'))).toBe(false);
  });

  it('找不到就响亮地失败', async () => {
    const { root } = await stage();
    await expect(
      createQwenJsonlSource({ harness: 'qwen', providerSessionId: 'nope', roots: [root] }).start({
        onEntries: () => {},
        onReset: () => {}
      })
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('branch_checkpoint 出边界：一条一个正常收尾', async () => {
    const { root, id } = await stage();
    const checkpoints = (await records()).filter((r) => r.subtype === 'branch_checkpoint').length;
    // 对照:这份记录里用户话比收尾多 —— 边界数不是「每句话都出一个」恰好数对。
    const users = (await records()).filter((r) => r.type === 'user' && r.provenance === 'real_user').length;
    expect(checkpoints).toBeGreaterThan(0);
    expect(users).toBeGreaterThan(checkpoints);
    const { entries, started } = collect(createQwenJsonlSource({ harness: 'qwen', providerSessionId: id, roots: [root] }));
    await started;
    const bounds = boundaryEntries(entries);
    expect(bounds).toHaveLength(checkpoints);
    for (const bound of bounds) expect(bound.boundary).toEqual({ kind: 'turn_end', stopReason: 'end_turn' });
  });

  it('接到时间线上：工具结果成功、出错、取消都折进工具行;以 end_turn 收尾的那几轮结局是 done', async () => {
    const { root, id } = await stage();
    const timeline = await createSessionTimeline(
      createQwenJsonlSource({ harness: 'qwen', providerSessionId: id, roots: [root] }),
      { sessionId: 'conv-qwen' }
    );
    disposers.push(() => timeline.dispose());
    const turns = timeline.getSnapshot().turns;
    expect(turns.length).toBeGreaterThan(1);
    expect(turns.filter((turn) => turn.outcome?.kind === 'done').length).toBeGreaterThanOrEqual(4);
    const tools = collectItems(turns).filter((item) => item.kind.endsWith('-tool-call')) as Array<{ status: string }>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.status)).toContain('error');
    expect(tools.map((tool) => tool.status)).toContain('done');
  });

  it('尾读：接着叶子写的只发增量;/rewind 另起一支 ⇒ 整份重来，丢掉的那一支不再出现', async () => {
    const { root, file, id } = await stage();
    const all = await records();
    const leaf = all[all.length - 1];
    const firstUser = all.find((r) => r.type === 'user' && r.provenance === 'real_user')!;
    const lastUser = [...all].reverse().find((r) => r.type === 'user' && r.provenance === 'real_user')!;
    const source = createQwenJsonlSource({ harness: 'qwen', providerSessionId: id, roots: [root] }, { pollIntervalMs: 60_000 });
    const { entries, resets, started } = collect(source);
    await started;
    const before = entries.length;

    const userLine = (uuid: string, parentUuid: string, text: string) =>
      JSON.stringify({ uuid, parentUuid, sessionId: id, timestamp: '2026-10-17T08:00:00.000Z', type: 'user', provenance: 'real_user', message: { role: 'user', parts: [{ text }] } });

    await appendFile(file, `${userLine('tail-0001', leaf.uuid, '接着说')}\n`);
    await source.catchUp?.();
    expect(resets).toEqual([]);
    expect(entries.slice(before).map((entry) => entry.key)).toEqual(['qwen:tail-0001#0']);

    entries.length = 0;
    await appendFile(file, `${userLine('fork-0001', firstUser.uuid, '换个思路')}\n`);
    await source.catchUp?.();
    expect(resets).toEqual(['source_replaced']);
    const keys = entries.map((entry) => entry.key);
    expect(keys).toContain('qwen:fork-0001#0');
    expect(keys).toContain(`qwen:${firstUser.uuid}#0`);
    expect(keys).not.toContain('qwen:tail-0001#0');
    expect(keys).not.toContain(`qwen:${lastUser.uuid}#0`);
  });
});
