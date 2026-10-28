import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runningBackgroundCommands } from '../../acp/background-commands';
import { createSessionTimeline } from '../timeline';
import { createClaudeJsonlSource } from './claude-jsonl';

/**
 * 后台命令(`run_in_background` 的 Bash,#5117)在**记录**里的形状(2026-10-28 真机 1047.1,mac1 dev 主机):
 *   ① assistant 的 tool_use{name:Bash, input.run_in_background:true}
 *   ② user 的 tool_result,`toolUseResult.backgroundTaskId` = 任务 id
 *   ③ 跑完后一条 user 字符串消息 `<task-notification><task-id>…<tool-use-id>…<status>completed…`
 * 手机看会话读的就是这份记录(不是运行时的 ACP 流),没有这一路,手机末尾那一句「后台 · 1 条命令」永远不出来。
 */
const SESSION = 'b1b2c3d4-0000-4000-8000-00000000bb01';
const disposers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

const base = (uuid: string, parentUuid: string | null, at: string) => ({ parentUuid, isSidechain: false, uuid, timestamp: at, sessionId: SESSION, cwd: '/work' });
const prompt = base('u-1', null, '2026-10-28T07:40:00.000Z');
const launch = { ...base('a-1', 'u-1', '2026-10-28T07:40:05.000Z'), type: 'assistant', message: { id: 'msg-1', type: 'message', role: 'assistant', stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'call_bg', name: 'Bash', input: { command: 'sleep 150', description: 'Sleep for 150 seconds', run_in_background: true } }] } };
const started = { ...base('u-2', 'a-1', '2026-10-28T07:40:06.000Z'), type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_bg', content: 'Command running in background with ID: byi2tsemx.' }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: 'byi2tsemx' } };
const reply = { ...base('a-2', 'u-2', '2026-10-28T07:40:08.000Z'), type: 'assistant', message: { id: 'msg-2', type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started.' }] } };
const done = { ...base('u-3', 'a-2', '2026-10-28T07:42:36.000Z'), type: 'user', message: { role: 'user',
  content: '<task-notification>\n<task-id>byi2tsemx</task-id>\n<tool-use-id>call_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command "Sleep for 150 seconds" completed (exit code 0)</summary>\n</task-notification>' } };
const lines = [{ ...prompt, type: 'user', message: { role: 'user', content: 'run sleep 150 in the background' } }, launch, started, reply];

async function timelineOf(records: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'claude-bg-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '-work'), { recursive: true });
  await writeFile(join(root, '-work', `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const timeline = await createSessionTimeline(createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION, roots: [root] }), { sessionId: 'bg' });
  disposers.push(() => timeline.dispose());
  return timeline.getSnapshot().turns;
}

describe('background commands in the Claude record', () => {
  it('marks the launching Bash call with its background task id after the turn settled', async () => {
    const running = runningBackgroundCommands(await timelineOf(lines), null);
    expect(running.map((node) => [node.toolCallId, node.backgroundTaskId])).toEqual([['call_bg', 'byi2tsemx']]);
  });

  it('is no longer running once its task notification arrives', async () => {
    expect(runningBackgroundCommands(await timelineOf([...lines, done]), null)).toEqual([]);
  });
});
