import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitPending } from '../../../../../tests/support/awaitFact';

import type { RecordEntry, SessionRecordSource, TimelineAfterResult } from '../contract';
import { createSessionTimeline } from '../timeline';
import {
  boundaryEntries,
  collectItems,
  contentEntries,
  type ContentEntry,
  type ToolItemView
} from '../test-support';
import { toolDisplayName, type ToolCallItem } from '../../acp/models/turns/tool-calls';
import { createCodexJsonlSource } from './codex-jsonl';
import { SessionRecordNotFoundError } from './shared';

const FIXTURE = fileURLToPath(new URL('../__fixtures__/codex-rollout.jsonl', import.meta.url));
const THREAD_ID = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function fixtureLines(): Promise<string[]> {
  return (await readFile(FIXTURE, 'utf8')).split('\n').filter((line) => line.trim());
}

async function stage(lines?: string[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-record-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  // 真实布局是 年/月/日 三层，源必须自己下钻找到它。
  const dayDir = join(root, '2026', '06', '18');
  await mkdir(dayDir, { recursive: true });
  const file = join(dayDir, `rollout-2026-06-18T07-03-21-${THREAD_ID}.jsonl`);
  await writeFile(file, (lines ?? (await fixtureLines())).join('\n') + '\n');
  return { root, file };
}

function startAll(source: SessionRecordSource): Promise<RecordEntry[]> {
  const entries: RecordEntry[] = [];
  disposers.push(() => source.stop());
  return source
    .start({ onEntries: (batch) => entries.push(...batch), onReset: () => {} })
    .then(() => entries);
}

/** 只要内容条 —— 解码类断言不关心边界条，让它们混进来只会到处判 update 在不在。 */
function start(source: SessionRecordSource): Promise<ContentEntry[]> {
  return startAll(source).then(contentEntries);
}

describe('codex rollout 记录源', () => {
  it('native subagent activity loads its own record, preserving nested ownership and history', async () => {
    const childId = 'native-child-thread';
    const line = (type: string, payload: object) => JSON.stringify({ type, timestamp: '2026-06-18T07:03:21Z', payload });
    const { root, file } = await stage([
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Audit permissions' }] }),
      line('response_item', { type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn', arguments: JSON.stringify({ task_name: 'audit', message: 'Inspect permissions' }) }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'spawn', kind: 'started', agent_thread_id: childId, agent_path: '/root/audit' } }),
      line('response_item', { type: 'function_call_output', call_id: 'spawn', output: '{"task_name":"/root/audit"}' }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'done', kind: 'completed', agent_thread_id: childId, agent_path: '/root/audit' } }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PARENT_RESULT' }] }),
      line('event_msg', { type: 'task_complete' }),
    ]);
    await writeFile(file.replace(THREAD_ID, childId), [
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect permissions' }] }),
      line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'CHILD_THOUGHT' }] }),
      line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'child-step', arguments: '{"cmd":"inspect"}' }),
      line('response_item', { type: 'function_call_output', call_id: 'child-step', output: 'CHILD_TOOL_RESULT' }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CHILD_RESULT' }] }),
      line('event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n');
    const source = createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] });
    const timeline = await createSessionTimeline(source, { sessionId: 'native-parent' });
    disposers.push(() => timeline.dispose());
    const snapshot = timeline.getSnapshot();
    const all = snapshot.turns.flatMap((turn) => turn.items);
    expect(all.filter((item) => item.kind === 'message' && item.role === 'assistant').map((item) => item.kind === 'message' ? item.text : ''))
      .toEqual(['PARENT_RESULT']);
    const launch = all.find((item) => item.kind === 'spawn-subagent-tool-call');
    expect(launch).toMatchObject({ agentStatus: 'completed', outputText: 'CHILD_RESULT', reasoningText: 'CHILD_THOUGHT',
      children: [expect.objectContaining({ toolCallId: 'child-step' })] });
    expect(all.filter((item) => item.kind === 'subagent-done-tool-call')).toEqual([
      expect.objectContaining({ outputText: 'CHILD_RESULT' }),
    ]);
    const archive = await timeline.archive!();
    expect(archive).not.toBeNull();
    timeline.dispose();
    const reopened = await createSessionTimeline(createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] }), {
      sessionId: 'native-parent', archive: archive!,
    });
    disposers.push(() => reopened.dispose());
    expect(reopened.getSnapshot().turns).toEqual(snapshot.turns);

    // Only the child advances while the parent file stays unchanged. The composite resume
    // must restore its watcher and recognize follow-up turns with no new user-message item.
    await appendFile(file.replace(THREAD_ID, childId), [
      line('event_msg', { type: 'task_started' }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'FOLLOW_UP_RESULT' }] }),
      line('event_msg', { type: 'task_complete' }),
    ].join('\n') + '\n');
    await reopened.catchUp();
    const afterFollowup = reopened.getSnapshot().turns.flatMap((turn) => turn.items);
    expect(afterFollowup.filter((item) => item.kind === 'spawn-subagent-tool-call')).toEqual([
      expect.objectContaining({ agentStatus: 'completed', outputText: 'FOLLOW_UP_RESULT' }),
    ]);
    expect(afterFollowup.filter((item) => item.kind === 'subagent-done-tool-call')).toEqual([
      expect.objectContaining({ outputText: 'FOLLOW_UP_RESULT' }),
    ]);
    expect(afterFollowup.filter((item) => item.kind === 'message' && item.role === 'assistant')).toEqual([
      expect.objectContaining({ text: 'PARENT_RESULT' }),
    ]);
  });

  it('找不到 rollout 时响亮地失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-empty-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    await expect(
      start(
        createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
      )
    ).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('在 年/月/日 目录下钻找到 rollout 并解码', async () => {
    const { root } = await stage();
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const kinds = entries.map((entry) => entry.update.sessionUpdate);
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('agent_thought_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    for (const entry of entries) {
      expect(entry.key).toMatch(new RegExp(`^codex:${THREAD_ID}:\\d+:\\d+$`));
      expect(typeof entry.at).toBe('number');
    }
  });

  it('key 用序号而不是 codex 自己的 id，且回合序号随 task_started 前进', async () => {
    const { root } = await stage();
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const turns = entries.map((entry) => Number(entry.key.split(':')[2]));
    expect(new Set(turns).size).toBeGreaterThan(1);
    expect([...turns].sort((a, b) => a - b)).toEqual(turns);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);

    // 阳性对照：fixture 里确实有 task_started，回合分档不是"因为只有一个回合"才对。
    const lines = await fixtureLines();
    expect(lines.filter((line) => line.includes('"task_started"')).length).toBeGreaterThan(0);
  });

  it('同一句话不因为 codex 记两遍就说两遍', async () => {
    const lines = await fixtureLines();
    const assistantResponseItems = lines.filter(
      (line) => line.includes('"response_item"') && line.includes('"role":"assistant"')
    ).length;
    const agentMessageEvents = lines.filter((line) => line.includes('"agent_message"')).length;
    // 阳性对照：两条通道在 fixture 里都在。少了任何一条，这个判据就只是空转。
    expect(assistantResponseItems).toBeGreaterThan(0);
    expect(agentMessageEvents).toBeGreaterThan(0);

    const { root } = await stage(lines);
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const assistantChunks = entries.filter(
      (entry) => entry.update.sessionUpdate === 'agent_message_chunk'
    );
    expect(assistantChunks).toHaveLength(assistantResponseItems);
  });

  it('注入的运行时上下文与密文推理都不算会话内容', async () => {
    const lines = await fixtureLines();
    expect(lines.some((line) => line.includes('<environment_context>'))).toBe(true);
    expect(lines.some((line) => line.includes('"summary":[]'))).toBe(true);

    const { root } = await stage(lines);
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const userTexts = entries
      .filter((entry) => entry.update.sessionUpdate === 'user_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(userTexts.length).toBeGreaterThan(0);
    expect(userTexts.some((text) => text.startsWith('<'))).toBe(false);

    const thoughts = entries.filter(
      (entry) => entry.update.sessionUpdate === 'agent_thought_chunk'
    );
    expect(thoughts).toHaveLength(1); // 两条 reasoning，只有带明文摘要的那条算数
    expect(
      (thoughts[0].update as { content: { text: string } }).content.text
    ).not.toContain('REDACTED_BLOB');
  });

  it('#6830 只写原文、摘要为空的思考（GLM）照样读出来；摘要与原文都有时画摘要', async () => {
    const reasoning = (summary: string[], raw: string[]) => JSON.stringify({
      timestamp: '2026-09-29T15:20:20.000Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: summary.map((text) => ({ type: 'summary_text', text })),
        content: raw.map((text) => ({ type: 'reasoning_text', text })),
        encrypted_content: null
      }
    });
    const { root } = await stage([
      ...(await fixtureLines()),
      reasoning([], ['We need execute.']),
      reasoning(['**Timing the trip**', 'Moving time is 202.'], ['raw chain'])
    ]);
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const thoughts = entries
      .filter((entry) => entry.update.sessionUpdate === 'agent_thought_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(thoughts.slice(-2)).toEqual(['We need execute.', '**Timing the trip**\n\nMoving time is 202.']);
  });

  it('AGENTS.md bootstrap is not rendered as the first user message', async () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-09-07T10:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work\\n\\nrepo rules' }]
        }
      }),
      JSON.stringify({
        timestamp: '2026-09-07T10:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '真实用户问题' }]
        }
      })
    ];
    const { root } = await stage(lines);
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const userTexts = entries
      .filter((entry) => entry.update.sessionUpdate === 'user_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(userTexts).toEqual(['真实用户问题']);
  });

  it('canonical gugu delivery input is retained as a user message', async () => {
    const delivery = '<gugu_delivery route="chat"><![CDATA[来自聊天页的消息]]></gugu_delivery>';
    const { root } = await stage([
      JSON.stringify({
        timestamp: '2026-09-07T10:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: delivery }],
        },
      }),
    ]);
    const entries = await start(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] }),
    );
    expect(entries.map((entry) => (entry.update as { content?: { text?: string } }).content?.text)).toContain(delivery);
  });

  describe('接到 timeline 上', () => {
    async function build(lines?: string[]) {
      const staged = await stage(lines);
      const source = createCodexJsonlSource(
        { harness: 'codex', providerSessionId: THREAD_ID, roots: [staged.root] },
        { pollIntervalMs: 100 }
      );
      const timeline = await createSessionTimeline(source, { sessionId: 'conv-codex' });
      disposers.push(() => timeline.dispose());
      return { ...staged, timeline };
    }

    it('MCP 工具记成 namespace + 名字:按 mcp__<server>__<tool> 认成 MCP 调用(#6900,手机看 Codex 会话)', async () => {
      const call = (name: string, namespace: string, args: unknown) => JSON.stringify({
        timestamp: '2026-10-05T08:25:43.440Z',
        type: 'response_item',
        payload: { type: 'function_call', name, namespace, arguments: JSON.stringify(args), call_id: `call_${name}` },
      });
      const { timeline } = await build([
        call('catalog_call', 'mcp__gugu', { tool: 'l3-dice__roll', args: {} }),
        call('spawn_agent', 'multi_agent_v1', {}),
      ]);
      const tools = collectItems(timeline.getSnapshot().turns).filter((item): item is ToolCallItem => item.kind.endsWith('-tool-call'));
      expect(tools.map((tool) => toolDisplayName(tool))).toEqual(['l3-dice__roll', 'spawn_agent']);
      expect(tools[0]).toMatchObject({ kind: 'mcp-tool-call', server: 'gugu', tool: 'catalog_call' });
    });

    // 148 10-14(旁观的活画面):手机看的是这份记录。MCP 工具的结果 codex 记成 input_text / input_image(mac1 实抓:
    // app_check 的 4 张图各一条 input_image,image_url 是 data: 地址);图要像实时 ACP 流那样成 content 里的 image 块。
    it('MCP 工具结果里的图成 image 块:按顺序留下,文字照旧是 outputText;只回文字的调用没有图(阴控)', async () => {
      const line = (payload: unknown) => JSON.stringify({ timestamp: '2026-10-14T09:19:00.000Z', type: 'response_item', payload });
      const call = (id: string) => line({ type: 'function_call', name: 'catalog_call', namespace: 'mcp__gugu', arguments: JSON.stringify({ tool: 'app_check', args: { tab_kind: 'op-probe.main' } }), call_id: id });
      const { timeline } = await build([
        call('call_pictures'),
        line({
          type: 'function_call_output',
          call_id: 'call_pictures',
          output: [
            { type: 'input_text', text: 'Wall time: 3.7 seconds\nOutput:' },
            { type: 'input_text', text: 'Picture: 952 wide, light' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AAAA', detail: 'auto' },
            { type: 'input_image', image_url: 'data:image/png;base64,iVBORBBBB', detail: 'auto' },
          ],
        }),
        call('call_text'),
        line({ type: 'function_call_output', call_id: 'call_text', output: [{ type: 'input_text', text: 'only words' }] }),
      ]);
      const tools = collectItems(timeline.getSnapshot().turns).filter((item): item is ToolCallItem => item.kind.endsWith('-tool-call'));
      const [pictures, words] = tools;
      expect(pictures.images).toEqual([
        { mimeType: 'image/jpeg', data: '/9j/AAAA' },
        { mimeType: 'image/png', data: 'iVBORBBBB' },
      ]);
      expect(pictures.outputText).toBe('Wall time: 3.7 seconds\nOutput:\nPicture: 952 wide, light');
      expect(words.outputText).toBe('only words');
      expect(words).not.toHaveProperty('images');
    });

    // 复核 10f3ea946c:同一批图别存两份(rawOutput 一份、images 一份 —— 真记录里存档 6.7 → 13.4 MB)。
    // 每一项都成了块,就不再留 rawOutput;有一项没成块(这里是不是 data: 地址的图),整份照旧留着,一点不丢。
    it('结果只存一份:每一项都成了块就没有 rawOutput;有一项没成块,整份 rawOutput 照留(阳控)', async () => {
      const line = (payload: unknown) => JSON.stringify({ timestamp: '2026-10-15T08:20:00.000Z', type: 'response_item', payload });
      const call = (id: string) => line({ type: 'function_call', name: 'catalog_call', namespace: 'mcp__gugu', arguments: '{}', call_id: id });
      const linked = [
        { type: 'input_text', text: 'Picture: 952 wide, light' },
        { type: 'input_image', image_url: 'https://example.invalid/a.png', detail: 'auto' },
      ];
      const { timeline } = await build([
        call('call_carried'),
        line({
          type: 'function_call_output',
          call_id: 'call_carried',
          output: [
            { type: 'input_text', text: 'Picture: 952 wide, light' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/AAAA', detail: 'auto' },
          ],
        }),
        call('call_linked'),
        line({ type: 'function_call_output', call_id: 'call_linked', output: linked }),
      ]);
      const tools = collectItems(timeline.getSnapshot().turns).filter((item): item is ToolCallItem => item.kind.endsWith('-tool-call'));
      const [carried, partly] = tools;
      expect(carried.images).toEqual([{ mimeType: 'image/jpeg', data: '/9j/AAAA' }]);
      expect(carried).not.toHaveProperty('rawOutput');
      expect(String(partly.rawOutput)).toContain('https://example.invalid/a.png');
    });

    it('function_call_output 到了才算完成', async () => {
      const { timeline } = await build();
      const tools = collectItems(timeline.getSnapshot().turns).filter(
        (item): item is ToolItemView => item.kind.endsWith('-tool-call')
      );
      expect(tools.some((tool) => tool.status === 'done')).toBe(true);
    });

    it('阴控：没有 function_call_output 时工具状态不是 completed', async () => {
      const lines = await fixtureLines();
      // 连 task_complete 一起去掉：一轮收尾时 reducer 会把 running 的工具结成 done
      // （finalizeItems，既有行为）。留着它，这条阴控会为了一个与"有没有 output"无关的
      // 理由变红/变绿，判的就不是它要判的那件事。
      const trimmed = lines.filter(
        (line) => !line.includes('"function_call_output"') && !line.includes('"task_complete"')
      );
      expect(trimmed.length).toBeLessThan(lines.length);

      const { timeline } = await build(trimmed);
      const tools = collectItems(timeline.getSnapshot().turns).filter(
        (item): item is ToolItemView => item.kind.endsWith('-tool-call')
      );
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((tool) => tool.status !== 'done')).toBe(true);
    });

    it('追加一行后，订阅者收到增量', async () => {
      const { file, timeline } = await build();
      const seen: TimelineAfterResult[] = [];
      // 等订阅者真的收到一批(fs.watch 或下一拍轮询,谁先到都算),❌ 押一个墙钟期限。
      let delivered!: () => void;
      const firstDelivery = new Promise<void>((resolve) => (delivered = resolve));
      disposers.push(
        timeline.subscribe(timeline.getSnapshot().cursor, (result) => {
          seen.push(result);
          delivered();
        })
      );

      await appendFile(
        file,
        JSON.stringify({
          timestamp: '2026-09-04T10:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '尾读到了' }]
          }
        }) + '\n'
      );

      await awaitPending('subscriber receives the appended line', firstDelivery);
      const texts = seen
        .flatMap((result) => (result.ok ? result.batch.turns : result.snapshot.turns))
        .flatMap((turn) => collectItems([turn]))
        .filter((item) => item.kind === 'message')
        .map((item) => (item as { text: string }).text);
      expect(texts.join('')).toContain('尾读到了');
    });
  });

  it('task_complete 出边界，task_started 不出', async () => {
    const { root } = await stage();
    const all = await startAll(
      createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] })
    );
    const bounds = boundaryEntries(all);
    expect(bounds).toHaveLength(1);
    expect(bounds[0].boundary).toEqual({ kind: 'turn_end', stopReason: 'end_turn' });

    // 阳性对照：这份记录里 task_started 有两条 —— 只出一条边界不是因为 event_msg 整路没读到。
    const lines = await fixtureLines();
    const starts = lines
      .map((line) => JSON.parse(line) as { payload?: { type?: string } })
      .filter((record) => record.payload?.type === 'task_started');
    expect(starts.length).toBeGreaterThan(1);
  });

  it('task_complete 带 error ⇒ 这一轮失败(codex 自己就按这一格判 Failed)', async () => {
    const lines = await fixtureLines();
    const failed = lines.map((line) => {
      const record = JSON.parse(line) as { type?: string; payload?: { type?: string } & Record<string, unknown> };
      if (record.type !== 'event_msg' || record.payload?.type !== 'task_complete') return line;
      return JSON.stringify({ ...record, payload: { ...record.payload, error: { message: 'stream disconnected before completion' } } });
    });
    // 对照:改的确实是那条收尾行 —— 没有 task_complete 的话这条用例什么都没测。
    expect(failed.join('\n')).not.toBe(lines.join('\n'));
    const { root } = await stage(failed);
    const bounds = boundaryEntries(
      await startAll(createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] }))
    );
    expect(bounds.map((bound) => bound.boundary)).toEqual([{ kind: 'turn_failed' }]);
  });


  it('#6357 带存档重开:关着时写进来的新一轮,键与整份重读一致(❌ 不许从 0 重编号撞上存档里的旧键)', async () => {
    const lines = await fixtureLines();
    // 夹具里有两轮(第 2 条 task_started 在第 11 行):存档停在第一轮之后,第二轮在「关着」时写入。
    const cut = lines.findIndex((line, i) => i > 3 && line.includes('"task_started"'));
    expect(cut).toBeGreaterThan(0);
    const { root, file } = await stage(lines.slice(0, cut));
    const locator = { harness: 'codex' as const, providerSessionId: THREAD_ID, roots: [root] };

    const first = createCodexJsonlSource(locator);
    await startAll(first);
    const resume = await first.resumePoint!();
    first.stop();
    expect(resume).not.toBeNull();

    await appendFile(file, lines.slice(cut).join('\n') + '\n');
    const again = createCodexJsonlSource(locator);
    const tail: RecordEntry[] = [];
    disposers.push(() => again.stop());
    await again.start({ onEntries: (batch) => tail.push(...batch), onReset: () => {} }, resume!);

    // 判据:续读出来的每一条,键都与「整份从头读」里同一条记录的键逐字相同。
    const full = await startAll(createCodexJsonlSource(locator));
    const fullKeys = full.map((entry) => entry.key);
    const tailKeys = tail.map((entry) => entry.key);
    expect(tailKeys.length).toBeGreaterThan(0);
    expect(fullKeys.slice(fullKeys.length - tailKeys.length)).toEqual(tailKeys);
    // 第二轮的 user 输入必须在续读结果里,且不与第一轮的任何键同名。
    const firstKeys = new Set(fullKeys.slice(0, fullKeys.length - tailKeys.length));
    expect(tailKeys.filter((key) => firstKeys.has(key))).toEqual([]);
  });

  // #7035 终端腿的 request_user_input:形状照 codex 0.153.4 的真实 rollout(在选择器上按 Esc 打断)。
  describe('request_user_input 进结算(#7035)', () => {
    const CALL = 'call_ef3d3eb54d054e18a883eb05a4fc1f25';
    const asked = JSON.stringify({
      timestamp: '2026-10-08T16:45:24.021Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        arguments: JSON.stringify({
          questions: [{
            header: 'Color',
            id: 'color',
            question: 'Which color do you prefer?',
            options: [{ label: 'Red', description: 'Choose red.' }, { label: 'Blue', description: 'Choose blue.' }],
          }],
        }),
        call_id: CALL,
      },
    });
    const aborted = JSON.stringify({
      timestamp: '2026-10-08T16:45:25.567Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: CALL, output: 'aborted by user after 1.5s' },
    });

    async function open(lines: string[], answerableQuestions: boolean) {
      const staged = await stage([...(await fixtureLines()), ...lines]);
      const source = createCodexJsonlSource(
        { harness: 'codex', providerSessionId: THREAD_ID, roots: [staged.root] },
        { pollIntervalMs: 60_000 }
      );
      const timeline = await createSessionTimeline(source, { sessionId: 'conv-codex', answerableQuestions });
      disposers.push(() => timeline.dispose());
      const settlement = () => timeline.getSnapshot().settlements.find((s) => s.itemId === CALL);
      return { ...staged, timeline, settlement };
    }

    it('问出来:题目原样带上,选择器开着', async () => {
      const { timeline, settlement } = await open([asked], true);
      expect(settlement()).toMatchObject({
        kind: 'question',
        state: 'pending',
        questions: [{
          question: 'Which color do you prefer?',
          header: 'Color',
          multiSelect: false,
          options: [{ optionId: 'Red', description: 'Choose red.' }, { optionId: 'Blue', description: 'Choose blue.' }],
        }],
      });
      expect(timeline.questionOpen(CALL)).toBe(true);
    });

    it('Esc 打断后记录里有了「aborted by user」⇒ 选择器关了', async () => {
      const { file, timeline, settlement } = await open([asked], true);
      await appendFile(file, aborted + '\n');
      await timeline.catchUp();
      expect(timeline.questionOpen(CALL)).toBe(false);
      expect(settlement()).toMatchObject({ resultRecorded: true });
    });

    it('阴性对照:宿主答不了 ⇒ 不带题目', async () => {
      const { settlement } = await open([asked], false);
      expect(settlement()).toMatchObject({ kind: 'question', state: 'pending' });
      expect(settlement()?.questions).toBeUndefined();
    });

    // 10-12 评审:没人在咕咕里认领、codex 自己做完的一问,答没答不能看「正常结束」—— codex 没答的几种结局都是正常输出。
    // 输出原文取自 mac1 ~/.codex/sessions 里出现过的全部 12 次 request_user_input(1 次真回答,11 次没答)。
    it.each([
      ['选择器上按 Esc', 'aborted by user after 1.5s', 'cancelled'],
      ['Default 模式下不能问(mac1 7 次)', 'request_user_input is unavailable in Default mode', 'cancelled'],
      ['咕咕适配器渲染不出来,如实回的空答案(2 次)', '{"answers":{}}', 'cancelled'],
      ['只有根线程能问', 'request_user_input can only be used by the root thread', 'cancelled'],
      ['真回答(1 次)', '{"answers":{"color":{"answers":["Blue"]}}}', 'resolved'],
    ] as const)('没人认领、codex 做完:%s ⇒ %s', async (_case, output, state) => {
      const { file, timeline, settlement } = await open([asked], true);
      await appendFile(file, JSON.stringify({
        timestamp: '2026-10-08T16:45:25.567Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: CALL, output },
      }) + '\n');
      await timeline.catchUp();
      expect(settlement()).toMatchObject({ state, resolvedBy: null, resultRecorded: true });
    });
  });
});
