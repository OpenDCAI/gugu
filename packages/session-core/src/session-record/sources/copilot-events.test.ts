import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { RecordEntry, SessionRecordResume, SessionRecordSource } from '../contract';
import { createSessionTimeline } from '../timeline';
import { boundaryEntries, contentEntries } from '../test-support';
import { createCopilotEventsSource } from './copilot-events';
import { SessionRecordNotFoundError } from './shared';

/**
 * 三份 copilot 真记录(mac1 `~/.copilot/session-state/<id>/events.jsonl`,copilot 1.0.83 / 1.0.88 写的),
 * 只留解码要读的字段，路径一律换成 `/w`、遥测事件(model.*、hook.*、用量)删掉:
 *  · aborted:第一轮跑完工具后正常收尾;第二轮工具起跑后被用户打断(`abort`);
 *  · error:一轮，模型限流重试用尽(`session.error`),一个字没回;
 *  · subagent:主 agent 起一个后台子代理(`task`),子代理的提示词与消息、工具都记在同一个文件里。
 */
const fixture = (name: string) => fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url));

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

type Event = { type: string; id: string; data: Record<string, unknown> };

async function events(name: string): Promise<Event[]> {
  return (await readFile(fixture(name), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Event);
}

/** 照 copilot 的布局摆一份:`<root>/<会话 id>/events.jsonl`。 */
async function stage(name: string): Promise<{ root: string; file: string; id: string }> {
  const id = (await events(name))[0].data.sessionId as string;
  const root = await mkdtemp(join(tmpdir(), 'copilot-record-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, id));
  const file = join(root, id, 'events.jsonl');
  await copyFile(fixture(name), file);
  return { root, file, id };
}

function collect(source: SessionRecordSource, resume?: SessionRecordResume) {
  const entries: RecordEntry[] = [];
  const resets: string[] = [];
  disposers.push(() => source.stop());
  const started = source.start({ onEntries: (batch) => entries.push(...batch), onReset: (reason) => resets.push(reason) }, resume);
  return { entries, resets, started };
}

async function timelineOf(name: string) {
  const { root, id } = await stage(name);
  const timeline = await createSessionTimeline(
    createCopilotEventsSource({ harness: 'copilot', providerSessionId: id, roots: [root] }),
    { sessionId: `conv-${name}` }
  );
  disposers.push(() => timeline.dispose());
  return timeline.getSnapshot().turns;
}

describe('copilot events.jsonl 记录源', () => {
  it('按候选根依次找 `<id>/events.jsonl`;哪个根都没有就响亮地失败', async () => {
    const { root, id } = await stage('copilot-aborted.jsonl');
    const { entries, started } = collect(
      createCopilotEventsSource({ harness: 'copilot', providerSessionId: id, roots: [join(root, 'missing'), root] })
    );
    await started;
    const kinds = contentEntries(entries).map((entry) => entry.update.sessionUpdate);
    expect(kinds).toEqual(expect.arrayContaining(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']));
    for (const entry of entries) expect(entry.key.startsWith('copilot:')).toBe(true);

    await expect(
      createCopilotEventsSource({ harness: 'copilot', providerSessionId: 'nope', roots: [root] }).start({
        onEntries: () => {},
        onReset: () => {}
      })
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('回合边界：不再要工具的那条 assistant.message 收尾,abort 是打断;assistant.turn_end 不算', async () => {
    const all = await events('copilot-aborted.jsonl');
    // 对照:turn_end 按模型步发(这份里 3 次),回合只有 2 个 —— 拿它当边界会多出一个。
    expect(all.filter((event) => event.type === 'assistant.turn_end')).toHaveLength(3);
    const { root, id } = await stage('copilot-aborted.jsonl');
    const { entries, started } = collect(createCopilotEventsSource({ harness: 'copilot', providerSessionId: id, roots: [root] }));
    await started;
    expect(boundaryEntries(entries).map((entry) => entry.boundary.kind)).toEqual(['turn_end', 'turn_aborted']);
  });

  it('接到时间线上：跑完的一轮是 done,被打断的一轮是 cancelled', async () => {
    const turns = await timelineOf('copilot-aborted.jsonl');
    expect(turns.map((turn) => turn.outcome?.kind)).toEqual(['done', 'cancelled']);
  });

  it('重试用尽的 session.error ⇒ 这一轮是出错，不停在进行中', async () => {
    const turns = await timelineOf('copilot-error.jsonl');
    expect(turns).toHaveLength(1);
    expect(turns[0].outcome?.kind).toBe('error');
  });

  it('子代理的提示词、消息、工具不进主时间线;它经主 agent 的 task 工具卡出现', async () => {
    const all = await events('copilot-subagent.jsonl');
    // 对照：这份真记录里子代理的三样都在 —— 下面的「没有」不是因为记录里本来就没有。
    expect(all.some((event) => event.type === 'user.message' && String(event.data.source).startsWith('agent-'))).toBe(true);
    expect(all.some((event) => event.type === 'assistant.message' && event.data.parentToolCallId)).toBe(true);
    expect(all.some((event) => event.type === 'tool.execution_complete' && event.data.parentToolCallId)).toBe(true);

    const { root, id } = await stage('copilot-subagent.jsonl');
    const { entries, started } = collect(createCopilotEventsSource({ harness: 'copilot', providerSessionId: id, roots: [root] }));
    await started;
    const content = contentEntries(entries);
    expect(content.filter((entry) => entry.update.sessionUpdate === 'user_message_chunk')).toHaveLength(1);
    const texts = content.flatMap((entry) =>
      entry.update.sessionUpdate === 'agent_message_chunk' && entry.update.content.type === 'text' ? [entry.update.content.text] : []
    );
    expect(texts).not.toContain('SUBDONE');
    expect(texts).toContain('T-70-46fx8');
    const toolIds = content.flatMap((entry) => (entry.update.sessionUpdate === 'tool_call' ? [entry.update.toolCallId] : []));
    expect(toolIds).toContain('call_7556ad8fe66c4d8c9237818c');
    expect(toolIds).not.toContain('call_3e8fb627d18b45628912e4f9');
  });

  it('尾读只发增量;续读点接得上，宿主重开后只读存档之后写进来的行', async () => {
    const { root, file, id } = await stage('copilot-aborted.jsonl');
    const locator = { harness: 'copilot' as const, providerSessionId: id, roots: [root] };
    const source = createCopilotEventsSource(locator, { pollIntervalMs: 60_000 });
    const { entries, resets, started } = collect(source);
    await started;
    const before = entries.length;
    const line = (eventId: string, type: string, data: Record<string, unknown>) =>
      JSON.stringify({ type, data, id: eventId, timestamp: '2026-09-12T06:00:00.000Z', parentId: null });

    await appendFile(file, `${line('tail-user', 'user.message', { content: '接着说' })}\n`);
    await source.catchUp?.();
    expect(resets).toEqual([]);
    expect(entries.slice(before).map((entry) => entry.key)).toEqual(['copilot:tail-user#0']);

    const resume = await source.resumePoint?.();
    expect(resume).toBeTruthy();
    source.stop();
    await appendFile(file, `${line('tail-reply', 'assistant.message', { content: '好的', toolRequests: [] })}\n`);
    const reopened = collect(createCopilotEventsSource(locator, { pollIntervalMs: 60_000 }), resume!);
    await reopened.started;
    expect(reopened.resets).toEqual([]);
    expect(reopened.entries.map((entry) => entry.key)).toEqual(['copilot:tail-reply#0', 'copilot:tail-reply#end']);
  });
});
