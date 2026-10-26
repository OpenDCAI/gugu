import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionRecordLocator } from '../contract';
import { createSessionTimeline } from '../timeline';
import { createClaudeJsonlSource } from './claude-jsonl';

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (disposers.length) await disposers.pop()?.(); });

const text = (text: string) => ({ type: 'text', text });
const use = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: string, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
function line(uuid: string, type: 'user' | 'assistant', content: unknown[], extra: object = {}) {
  return JSON.stringify({ uuid, type, sessionId: 'parent', timestamp: '2026-10-26T11:40:00Z',
    message: { role: type, id: uuid, content }, ...extra });
}
const end = (uuid: string, content: string, extra: object = {}) => JSON.stringify({
  ...JSON.parse(line(uuid, 'assistant', [text(content)], extra)),
  message: { role: 'assistant', id: uuid, content: [text(content)], stop_reason: 'end_turn' },
});
async function fixture(parent: string[], children: Record<string, string[]> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'claude-native-children-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'project');
  const childDirectory = join(directory, 'parent', 'subagents');
  await mkdir(childDirectory, { recursive: true });
  const file = join(directory, 'parent.jsonl');
  await writeFile(file, parent.join('\n') + '\n');
  for (const [id, lines] of Object.entries(children)) await writeFile(join(childDirectory, `agent-${id}.jsonl`), lines.join('\n') + '\n');
  const locator: SessionRecordLocator = { harness: 'claude', providerSessionId: 'parent', roots: [root] };
  return { file, childDirectory, locator };
}

const launch = (id: string, prompt: string, name = 'Agent') => use(id, name, { description: prompt, prompt, run_in_background: true });
const launched = (uuid: string, callId: string, agentId: string, extra: object = {}) => line(uuid, 'user', [result(callId, 'Agent launched')], {
  toolUseResult: { isAsync: true, status: 'async_launched', agentId }, ...extra,
});
const child = { isSidechain: true, agentId: 'worker' };

describe('Claude native subagent records', () => {
  it('projects nested child tools through the shared stream and restores independent child tails', async () => {
    const { locator, childDirectory } = await fixture([
      line('user', 'user', [text('Inspect the repository')]),
      line('launch', 'assistant', [launch('launch-worker', 'Audit')]),
      launched('launched', 'launch-worker', 'worker'),
      end('parent-end', 'PARENT_RESULT'),
    ], {
      worker: [
        line('child-user', 'user', [text('Audit')], child),
        line('child-thought', 'assistant', [{ type: 'thinking', thinking: 'CHILD_THOUGHT' }], child),
        line('child-shell', 'assistant', [use('child-step', 'Bash', { command: 'inspect' })], child),
        line('nested-launch', 'assistant', [launch('launch-nested', 'Nested audit', 'Task')], child),
        launched('nested-launched', 'launch-nested', 'nested', child),
      ],
      nested: [line('nested-user', 'user', [text('Nested audit')], { isSidechain: true, agentId: 'nested' }),
        end('nested-end', 'NESTED_RESULT', { isSidechain: true, agentId: 'nested' })],
    });
    const timeline = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'native-parent' });
    disposers.push(() => timeline.dispose());
    const snapshot = timeline.getSnapshot();
    const items = snapshot.turns.flatMap((turn) => turn.items);
    expect(items.filter((item) => item.kind === 'message')).toEqual([
      expect.objectContaining({ role: 'user', text: 'Inspect the repository' }),
      expect.objectContaining({ role: 'assistant', text: 'PARENT_RESULT' }),
    ]);
    expect(items.filter((item) => item.kind === 'unknown-tool-call')).toEqual([]);
    expect(items.find((item) => item.kind === 'spawn-subagent-tool-call')).toMatchObject({
      status: 'done', agentStatus: 'running', reasoningText: 'CHILD_THOUGHT',
      children: [expect.objectContaining({ toolCallId: 'child-step', status: 'running' }),
        expect.objectContaining({ kind: 'spawn-subagent-tool-call', agentStatus: 'completed', outputText: 'NESTED_RESULT' })],
    });
    expect(items.filter((item) => item.kind === 'subagent-done-tool-call')).toEqual([
      expect.objectContaining({ outputText: 'NESTED_RESULT' }),
    ]);
    const archive = await timeline.archive!();
    timeline.dispose();
    const reopened = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'native-parent', archive: archive! });
    disposers.push(() => reopened.dispose());
    expect(reopened.getSnapshot().turns).toEqual(snapshot.turns);
    await appendFile(join(childDirectory, 'agent-worker.jsonl'), [
      line('child-result', 'user', [result('child-step', 'SHELL_RESULT')], child),
      end('child-end', 'CHILD_RESULT', child),
    ].join('\n') + '\n');
    await reopened.catchUp();
    const updated = reopened.getSnapshot().turns.flatMap((turn) => turn.items);
    expect(updated.find((item) => item.kind === 'spawn-subagent-tool-call')).toMatchObject({
      agentStatus: 'completed', outputText: 'CHILD_RESULT', children: [
        expect.objectContaining({ toolCallId: 'child-step', status: 'done', outputText: 'SHELL_RESULT' }),
        expect.objectContaining({ kind: 'spawn-subagent-tool-call' }),
      ],
    });
    expect(updated.filter((item) => item.kind === 'message')).toEqual(items.filter((item) => item.kind === 'message'));
  });

  it('keeps a failed launch and ordinary completed tools without inventing a child identity', async () => {
    const { locator } = await fixture([
      line('user', 'user', [text('Run tools')]),
      line('launch', 'assistant', [launch('failed-launch', 'Audit')]),
      line('launch-failure', 'user', [result('failed-launch', 'Agent failed', true)]),
      line('shell', 'assistant', [use('ordinary-shell', 'Bash', { command: 'echo ok' })]),
      line('shell-result', 'user', [result('ordinary-shell', 'ok')]),
      end('end', 'DONE'),
    ]);
    const timeline = await createSessionTimeline(createClaudeJsonlSource(locator), { sessionId: 'failed-launch' });
    disposers.push(() => timeline.dispose());
    const items = timeline.getSnapshot().turns.flatMap((turn) => turn.items);
    expect(items.find((item) => item.kind === 'unknown-tool-call')).toMatchObject({ toolCallId: 'failed-launch', status: 'error' });
    expect(items.find((item) => item.kind === 'execute-tool-call')).toMatchObject({ toolCallId: 'ordinary-shell', status: 'done', outputText: 'ok' });
    expect(items.filter((item) => item.kind === 'spawn-subagent-tool-call')).toEqual([]);
  });
});
