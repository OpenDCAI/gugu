import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitPending } from '../../../../../tests/support/awaitFact';

import type { RecordEntry, SessionRecordSource, SessionTimeline, TimelineAfterResult } from '../contract';
import { createSessionTimeline } from '../timeline';
import { createClaudeJsonlSource } from './claude-jsonl';
import { readQuestion } from './question-tools';
import { SessionRecordNotFoundError } from './shared';

// 记下每份记录被「整份读」了几次：打开时间线串分叉链时，无关的记录不许被整份读进来。
const wholeReads = vi.hoisted(() => new Map<string, number>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const key = String(args[0]);
      wholeReads.set(key, (wholeReads.get(key) ?? 0) + 1);
      return actual.readFile(...args);
    }) as typeof actual.readFile
  };
});
import {
  boundaryEntries,
  collectItems,
  contentEntries,
  type ContentEntry,
  type ToolItemView
} from '../test-support';

const FIXTURE = fileURLToPath(new URL('../__fixtures__/claude-session.jsonl', import.meta.url));
const SESSION_ID = 'f1b2c3d4-0000-4000-8000-000000000001';

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

async function stage(lines?: string[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'claude-record-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const projectDir = join(root, '-work-repo');
  await mkdir(projectDir, { recursive: true });
  const file = join(projectDir, `${SESSION_ID}.jsonl`);
  const body = lines ?? (await readFile(FIXTURE, 'utf8')).split('\n').filter((l) => l.trim());
  await writeFile(file, body.join('\n') + '\n');
  return { root, file };
}

async function fixtureLines(): Promise<string[]> {
  return (await readFile(FIXTURE, 'utf8')).split('\n').filter((line) => line.trim());
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

describe('claude jsonl 记录源', () => {
  it('定位不到会话文件时响亮地失败', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-empty-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const source = createClaudeJsonlSource({
      harness: 'claude',
      providerSessionId: SESSION_ID,
      roots: [root]
    });
    await expect(start(source)).rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('把真实记录解码成 ACP SessionUpdate', async () => {
    const { root } = await stage();
    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );

    const kinds = entries.map((entry) => entry.update.sessionUpdate);
    expect(kinds).toContain('user_message_chunk');
    expect(kinds).toContain('agent_message_chunk');
    expect(kinds).toContain('agent_thought_chunk');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');

    for (const entry of entries) {
      expect(entry.key.startsWith('claude:')).toBe(true);
      expect(typeof entry.at).toBe('number');
      // 每一条都要能原样过 JSON —— 它们要经 Realtime 广播到手机。
      expect(() => JSON.stringify(entry.update)).not.toThrow();
    }
  });

  it('工具调用带上 ACP kind 与入参', async () => {
    const { root } = await stage();
    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const read = entries.find(
      (entry) => entry.update.sessionUpdate === 'tool_call' && entry.update.title === 'Read'
    );
    expect(read).toBeDefined();
    const call = read!.update as { kind?: string; rawInput?: unknown };
    expect(call.kind).toBe('read');
    expect(call.rawInput).toMatchObject({ file_path: expect.any(String) });

    // ACP 的 ToolKind 是封闭枚举：MCP 工具没有对应档位，只能落 'other'，
    // ❌ 不许为了好看塞一个语义不对的 kind。
    const mcp = entries.find(
      (entry) =>
        entry.update.sessionUpdate === 'tool_call' && entry.update.title.startsWith('mcp__')
    );
    expect(mcp).toBeDefined();
    expect((mcp!.update as { kind?: string }).kind).toBe('other');
  });

  it('机器注入的 user 记录不算用户消息', async () => {
    const { root } = await stage();
    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const userTexts = entries
      .filter((entry) => entry.update.sessionUpdate === 'user_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);

    expect(userTexts.length).toBeGreaterThan(0);
    expect(userTexts.some((text) => text.startsWith('<command-name>'))).toBe(false);
    expect(userTexts.some((text) => text.startsWith('Caveat:'))).toBe(false);

    // 阳性对照：这两条注入记录确实在 fixture 里，判据不是因为"根本没有这种行"才变绿。
    const lines = await fixtureLines();
    expect(lines.some((line) => line.includes('"isMeta":true'))).toBe(true);
    expect(lines.some((line) => line.includes('<command-name>'))).toBe(true);
  });

  it('canonical gugu delivery input is retained as a user message', async () => {
    const delivery = '<gugu_delivery route="chat"><![CDATA[来自聊天页的消息]]></gugu_delivery>';
    const { root } = await stage([
      JSON.stringify({
        type: 'user',
        uuid: 'delivery-user',
        timestamp: '2026-09-07T10:00:00.000Z',
        sessionId: SESSION_ID,
        message: { role: 'user', content: [{ type: 'text', text: delivery }] },
      }),
    ]);
    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] }),
    );
    expect(entries.map((entry) => (entry.update as { content?: { text?: string } }).content?.text)).toContain(delivery);
  });

  it('AskUserQuestion 能被上层认成提问', async () => {
    const { root } = await stage();
    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const asked = entries.map((entry) => readQuestion(entry.update)).filter((q) => q !== null);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.toolName).toBe('AskUserQuestion');
    expect(asked[0]!.kind).toBe('question');
    expect(asked[0]!.title.length).toBeGreaterThan(0);
    expect(asked[0]!.options.length).toBeGreaterThan(1);
    // optionId 必须是 provider 自己认得的字符串（AskUserQuestion 的回答协议就是 label 原文），
    // ❌ 不能是读侧编的序号 —— 那种 id 发回去 agent 认不得。
    for (const option of asked[0]!.options) {
      expect(option.optionId).toBe(option.name);
      expect(option.optionId).not.toMatch(/^\d+$/);
    }

    // 阴控：普通工具调用不许被认成提问。
    const read = entries.find(
      (entry) => entry.update.sessionUpdate === 'tool_call' && entry.update.title === 'Read'
    );
    expect(readQuestion(read!.update)).toBeNull();
  });

  it('多字节字符横跨读取块边界时不被切成替换字符', async () => {
    // 读取窗口是 256KB。这里把第二行第一个汉字的三个字节**精确**摆成 262142/262143/262144，
    // 于是它必然被两次 read 切开 —— 不是"多写点中文碰运气"。
    const boundary = 256 * 1024;
    const TEXT = '锚点汉字完好无损';
    const secondHead =
      '{"type":"assistant","uuid":"22222222-0000-4000-8000-000000000002",' +
      '"timestamp":"2026-09-04T00:00:01.000Z","isSidechain":false,"sessionId":"' +
      SESSION_ID +
      '","message":{"id":"msg_two","role":"assistant","content":[{"type":"text","text":"';
    const second = secondHead + TEXT + '"}]}}';
    expect(JSON.parse(second)).toBeTruthy();

    const firstOf = (pad: number) =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        uuid: '11111111-0000-4000-8000-000000000001',
        timestamp: '2026-09-04T00:00:00.000Z',
        sessionId: SESSION_ID,
        message: {
          id: 'msg_one',
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(pad) }]
        }
      });
    // 第一行（含换行）+ 第二行 ASCII 行首 = 汉字起始字节，要它落在 262142。
    const wantFirstBytes = boundary - 2 - Buffer.byteLength(secondHead);
    const pad = wantFirstBytes - 1 - Buffer.byteLength(firstOf(0));
    expect(pad).toBeGreaterThan(0);
    const first = firstOf(pad);
    const cjkStart = Buffer.byteLength(first) + 1 + Buffer.byteLength(secondHead);
    expect(cjkStart).toBe(boundary - 2);
    expect(cjkStart + 3).toBeGreaterThan(boundary);

    const { root } = await stage([first, second]);
    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const texts = entries
      .filter((entry) => entry.update.sessionUpdate === 'agent_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe(TEXT);
    expect(texts.join('')).not.toContain('\uFFFD');
  });

  it('--fork-session 的续写按 leaf 串上来，抄录的祖先记录只算一次', async () => {
    const lines = await fixtureLines();
    const { root, file } = await stage(lines);
    const leafUuid = JSON.parse(lines[lines.length - 1]).uuid as string;
    expect(typeof leafUuid).toBe('string');

    // 分叉文件 = 祖先记录**连 uuid 一起**抄一份（sessionId 换成自己的）+ 新记录。
    const forkId = 'aaaaaaaa-0000-4000-8000-0000000000ff';
    const copied = lines.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row.sessionId = forkId;
      return JSON.stringify(row);
    });
    const continuation = JSON.stringify({
      parentUuid: leafUuid,
      isSidechain: false,
      type: 'assistant',
      uuid: 'bbbbbbbb-0000-4000-8000-0000000000ff',
      timestamp: '2026-09-04T12:00:00.000Z',
      sessionId: forkId,
      message: {
        id: 'msg_fork',
        role: 'assistant',
        content: [{ type: 'text', text: '分叉之后说的话' }]
      }
    });
    const forkPath = join(dirname(file), `${forkId}.jsonl`);
    await writeFile(forkPath, [...copied, continuation].join('\n') + '\n');
    const later = new Date(Date.now() + 60_000);
    await utimes(forkPath, later, later);

    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const texts = entries
      .filter((entry) => entry.update.sessionUpdate === 'agent_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(texts.join('\n')).toContain('分叉之后说的话');
    // 抄录的那一段只算一次：条目数 = 单读本体的条目数 + 分叉新增的那一条，一条不多。
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
    const solo = await stage(lines);
    const baseline = await start(
      createClaudeJsonlSource({
        harness: 'claude',
        providerSessionId: SESSION_ID,
        roots: [solo.root]
      })
    );
    expect(entries).toHaveLength(baseline.length + 1);
  });

  it('串分叉链时，首条消息对不上的「更新、更大」的记录只看开头，不整份读', async () => {
    const lines = await fixtureLines();
    const { root, file } = await stage(lines);
    // 同目录里一份无关会话：更新、更大，但首条消息与本链无关。
    const otherId = 'abababab-0000-4000-8000-0000000000ff';
    const other = [
      JSON.stringify({ type: 'user', uuid: 'unrelated-root', sessionId: otherId, message: { role: 'user', content: 'x' } }),
      JSON.stringify({ type: 'attachment', uuid: 'unrelated-2', sessionId: otherId, attachment: { note: 'z'.repeat(200_000) } })
    ];
    const otherPath = join(dirname(file), `${otherId}.jsonl`);
    await writeFile(otherPath, other.join('\n') + '\n');
    const later = new Date(Date.now() + 60_000);
    await utimes(otherPath, later, later);
    expect((await stat(otherPath)).size).toBeGreaterThan((await stat(file)).size);
    wholeReads.clear();

    await start(createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] }));

    expect(wholeReads.get(otherPath) ?? 0).toBe(0);
  });

  // 守的是「压缩后的续写不许被挡掉」：它只从压缩点抄起、比源记录小，按首条消息认、不按大小认。
  it('会话压缩过之后的续写（从压缩点抄起）照样串上来', async () => {
    const lines = await fixtureLines();
    const boundary = JSON.stringify({
      parentUuid: null,
      logicalParentUuid: JSON.parse(lines[lines.length - 1]).uuid,
      isSidechain: false,
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'cbcbcbcb-0000-4000-8000-0000000000ff',
      timestamp: '2026-09-04T11:00:00.000Z',
      sessionId: SESSION_ID
    });
    const { root, file } = await stage([...lines, boundary]);

    // claude 2.1.266 实测：压缩后 `--fork-session` 的副本首条就是源会话的压缩点那一行，不再从开头抄。
    const forkId = 'cdcdcdcd-0000-4000-8000-0000000000ff';
    const continuation = JSON.stringify({
      parentUuid: 'cbcbcbcb-0000-4000-8000-0000000000ff',
      isSidechain: false,
      type: 'assistant',
      uuid: 'cececece-0000-4000-8000-0000000000ff',
      timestamp: '2026-09-04T12:00:00.000Z',
      sessionId: forkId,
      message: { id: 'msg_after_compact', role: 'assistant', content: [{ type: 'text', text: '压缩之后接着说' }] }
    });
    const forkPath = join(dirname(file), `${forkId}.jsonl`);
    await writeFile(
      forkPath,
      [JSON.stringify({ ...JSON.parse(boundary), sessionId: forkId }), continuation].join('\n') + '\n'
    );
    const later = new Date(Date.now() + 60_000);
    await utimes(forkPath, later, later);
    expect((await stat(forkPath)).size).toBeLessThan((await stat(file)).size);

    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const texts = entries
      .filter((entry) => entry.update.sessionUpdate === 'agent_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(texts.join('\n')).toContain('压缩之后接着说');
  });

  it('从更早的点岔出去的兄弟分叉不许被缝进来', async () => {
    const lines = await fixtureLines();
    const { root, file } = await stage(lines);

    // 只抄前两条（岔在中途），后面接自己的内容 —— 它不含本份记录的 leaf。
    const siblingId = 'cccccccc-0000-4000-8000-0000000000ff';
    const sibling = [
      ...lines.slice(0, 2).map((line) => JSON.stringify({ ...JSON.parse(line), sessionId: siblingId })),
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        uuid: 'dddddddd-0000-4000-8000-0000000000ff',
        timestamp: '2026-09-04T12:00:00.000Z',
        sessionId: siblingId,
        message: {
          id: 'msg_sibling',
          role: 'assistant',
          content: [{ type: 'text', text: '这是另一条对话' }]
        }
      }),
      // 补齐字节数，保证它比本体大 —— 免得只是被 size 粗筛挡掉，判据就成了空转。
      JSON.stringify({
        type: 'attachment',
        uuid: 'eeeeeeee-0000-4000-8000-0000000000ff',
        sessionId: siblingId,
        timestamp: '2026-09-04T12:00:01.000Z',
        attachment: { note: 'z'.repeat(40_000) }
      })
    ];
    const siblingPath = join(dirname(file), `${siblingId}.jsonl`);
    await writeFile(siblingPath, sibling.join('\n') + '\n');
    const later = new Date(Date.now() + 60_000);
    await utimes(siblingPath, later, later);
    expect((await stat(siblingPath)).size).toBeGreaterThan((await stat(file)).size);

    const entries = await start(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const texts = entries
      .filter((entry) => entry.update.sessionUpdate === 'agent_message_chunk')
      .map((entry) => (entry.update as { content: { text: string } }).content.text);
    expect(texts.join('\n')).not.toContain('这是另一条对话');
  });

  it('坏行只跳过并计数，不带走整份记录', async () => {
    const lines = await fixtureLines();
    const { root } = await stage([lines[0], '{ 这不是 JSON', ...lines.slice(1)]);
    const warnings: string[] = [];
    const entries = await start(
      createClaudeJsonlSource(
        { harness: 'claude', providerSessionId: SESSION_ID, roots: [root] },
        { warn: (message) => warnings.push(message) }
      )
    );
    expect(entries.length).toBeGreaterThan(3);
    expect(warnings.join('\n')).toContain('无法解析');
  });

  describe('接到 timeline 上', () => {
    async function build(lines?: string[], pollIntervalMs = 100) {
      const staged = await stage(lines);
      const source = createClaudeJsonlSource(
        { harness: 'claude', providerSessionId: SESSION_ID, roots: [staged.root] },
        { pollIntervalMs }
      );
      const timeline = await createSessionTimeline(source, { sessionId: 'conv-claude' });
      disposers.push(() => timeline.dispose());
      return { ...staged, timeline };
    }

    it('工具调用在收到 tool_result 后才算完成', async () => {
      const { timeline } = await build();
      const tools = collectItems(timeline.getSnapshot().turns).filter(
        (item): item is ToolItemView => item.kind.endsWith('-tool-call')
      );
      const done = tools.filter((tool) => tool.status === 'done');
      expect(done.length).toBeGreaterThan(0);
    });

    it('阴控：没有 tool_result 的记录，工具状态不是 completed', async () => {
      const lines = await fixtureLines();
      // 只删 tool_result，其余一字不动 —— 唯一变量就是"结果回没回来"。
      const withoutResults = lines.filter((line) => !line.includes('"tool_result"'));
      expect(withoutResults.length).toBeLessThan(lines.length);

      const { timeline } = await build(withoutResults);
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

      const appended = {
        parentUuid: null,
        isSidechain: false,
        type: 'assistant',
        uuid: '9f000000-0000-4000-8000-00000000ffff',
        timestamp: '2026-09-04T10:00:00.000Z',
        sessionId: SESSION_ID,
        message: { id: 'msg_tail', role: 'assistant', content: [{ type: 'text', text: '尾读到了' }] }
      };
      await appendFile(file, JSON.stringify(appended) + '\n');

      await awaitPending('subscriber receives the appended line', firstDelivery);
      const texts = seen
        .flatMap((result) => (result.ok ? result.batch.turns : result.snapshot.turns))
        .flatMap((turn) => collectItems([turn]))
        .filter((item) => item.kind === 'message')
        .map((item) => (item as { text: string }).text);
      expect(texts.join('')).toContain('尾读到了');
    });

    it('忙时到的输入(queued_command)各成一条用户消息,顺序照记录,连着的两条不接成一条', async () => {
      const at = (second: number) => `2026-09-29T12:00:0${second}.000Z`;
      const row = (uuid: string, second: number, body: Record<string, unknown>) =>
        JSON.stringify({ parentUuid: null, isSidechain: false, uuid, timestamp: at(second), sessionId: SESSION_ID, ...body });
      const queued = (uuid: string, attachment: Record<string, unknown>) =>
        row(uuid, 5, { type: 'attachment', attachment: { type: 'queued_command', ...attachment } });
      const envelope = (n: number) => `<gugu_delivery route="chat" msg="msg:${n}"><![CDATA[第 ${n} 条]]></gugu_delivery>`;
      // claude 2.1 真记录的形状:忙时到的输入只有 queue-operation(没有 uuid)+ queued_command 附件行,没有 user 行。
      const lines = [
        row('u-1', 1, { type: 'user', message: { role: 'user', content: envelope(1) } }),
        row('a-1', 2, {
          type: 'assistant',
          message: { id: 'msg_a1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 50' } }] }
        }),
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(3), sessionId: SESSION_ID, content: envelope(2) }),
        row('u-2', 4, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sleep', content: '' }] } }),
        queued('q-2', { commandMode: 'prompt', prompt: [{ type: 'text', text: envelope(2) }] }),
        queued('q-3', { commandMode: 'prompt', prompt: '人在忙时打的字' }),
        // 同一形状里不是输入的三种:后台任务通知、子 agent 回话(isMeta 在 attachment 里,有无 commandMode 两种都见过)。
        queued('q-4', { commandMode: 'task-notification', prompt: '<task-notification><task-id>b1</task-id></task-notification>' }),
        queued('q-5', { commandMode: 'prompt', prompt: '子 agent 回话', isMeta: true }),
        queued('q-6', { prompt: '<agent-message from="a1">子 agent 回话</agent-message>', isMeta: true }),
        row('a-2', 6, { type: 'assistant', message: { id: 'msg_a2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '都收到了' }] } })
      ];
      const { timeline } = await build(lines);
      const users = collectItems(timeline.getSnapshot().turns)
        .filter((item) => item.kind === 'message' && (item as { role?: string }).role === 'user')
        .map((item) => (item as { text: string }).text);
      expect(users).toEqual([envelope(1), envelope(2), '人在忙时打的字']);
    });

    it('被拒与报错各是一轮的结局:refusal 行也带 isApiErrorMessage,先认 refusal;其余带它的是报错', async () => {
      const at = (second: number) => `2026-10-17T00:20:0${second}.000Z`;
      const row = (uuid: string, second: number, body: Record<string, unknown>) =>
        JSON.stringify({ parentUuid: null, isSidechain: false, uuid, timestamp: at(second), sessionId: SESSION_ID, ...body });
      const ask = (uuid: string, second: number) => row(uuid, second, { type: 'user', message: { role: 'user', content: '接着写' } });
      // 两行都照真记录的形状(claude 2.1,10-17 本机记录):合成的 assistant 行,model `<synthetic>`。
      const synthetic = (uuid: string, second: number, message: Record<string, unknown>, error: string) =>
        row(uuid, second, {
          type: 'assistant',
          isApiErrorMessage: true,
          error,
          message: { id: `${uuid}-m`, model: '<synthetic>', role: 'assistant', type: 'message', stop_sequence: '', ...message }
        });
      const lines = [
        ask('u-1', 1),
        synthetic('a-1', 2, {
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'This request triggered restrictions on violative cyber content.', fallback_has_prefill_claim: false },
          content: [{ type: 'text', text: "API Error: Opus 5 (1M context)'s safeguards flagged this message" }]
        }, 'invalid_request'),
        ask('u-2', 3),
        synthetic('a-2', 4, {
          stop_reason: 'stop_sequence',
          stop_details: null,
          content: [{ type: 'text', text: 'API Error: 400 此 session 已绑定另外的ai账号，请执行/new 开启新 session' }]
        }, 'unknown'),
        ask('u-3', 5),
        row('a-3', 6, { type: 'assistant', message: { id: 'msg_a3', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '写完了' }] } })
      ];
      const { timeline } = await build(lines);
      expect(timeline.getSnapshot().turns.map((turn) => turn.outcome)).toEqual([
        { kind: 'done', reason: 'refusal' },
        { kind: 'error', reason: 'prompt_failed' },
        { kind: 'done', reason: 'end_turn' }
      ]);
    });

    it('拆除时存档:archive() 之后紧接着 dispose(),存档照样写得出来', async () => {
      // 宿主就是这个顺序(session-timeline 的 archiveBeforeDispose → dispose)。
      const { timeline } = await build();
      const archived = timeline.archive?.();
      timeline.dispose();
      await expect(archived).resolves.toMatchObject({ resume: { fingerprint: expect.stringMatching(/^claude:/) } });
    });

    it('压缩后的摘要不是用户说的话:摘要那条不画,压缩前后的真输入照常画(终端腿与 ACP 腿同一种行)', async () => {
      // claude 2.1.282 真记录的形状(mac1 2026-10-03,终端腿 /compact;ACP 腿只差 entrypoint:"sdk-ts")。
      const at = (second: number) => `2026-10-03T15:3${second}:00.000Z`;
      const row = (uuid: string, second: number, body: Record<string, unknown>) =>
        JSON.stringify({ parentUuid: null, isSidechain: false, uuid, timestamp: at(second), sessionId: SESSION_ID, entrypoint: 'cli', ...body });
      const lines = [
        row('u-1', 1, { type: 'user', message: { role: 'user', content: '压缩之前说的话' } }),
        row('a-1', 2, { type: 'assistant', message: { id: 'msg_a1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '收到' }] } }),
        row('c-1', 3, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 24287 } }),
        row('s-1', 4, {
          type: 'user',
          isCompactSummary: true,
          isVisibleInTranscriptOnly: true,
          message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.' }
        }),
        row('u-2', 5, { type: 'user', message: { role: 'user', content: '压缩之后说的话' } }),
        row('a-2', 6, { type: 'assistant', message: { id: 'msg_a2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '好' }] } })
      ];
      const { timeline } = await build(lines);
      const users = collectItems(timeline.getSnapshot().turns)
        .filter((item) => item.kind === 'message' && (item as { role?: string }).role === 'user')
        .map((item) => (item as { text: string }).text);
      expect(users).toEqual(['压缩之前说的话', '压缩之后说的话']);
    });

    describe('排队提示:ACP 腿投影宿主运行时那份队列(桌面「Queued prompts」同一份);终端腿不投影(owner 2026-10-04)', () => {
      const at = (second: number) => `2026-10-03T15:55:${String(second).padStart(2, '0')}.000Z`;
      const row = (uuid: string, second: number, body: Record<string, unknown>) =>
        JSON.stringify({ parentUuid: null, isSidechain: false, uuid, timestamp: at(second), sessionId: SESSION_ID, ...body });
      const op = (second: number, operation: string, content: string) =>
        JSON.stringify({ type: 'queue-operation', operation, timestamp: at(second), sessionId: SESSION_ID, content });
      const QUEUED = 'QUEUED-ACP-7731 reply with exactly: GOT-7731';
      const busy = [
        row('u-1', 1, { type: 'user', message: { role: 'user', content: 'Use the Bash tool to run exactly `sleep 120`' } }),
        row('a-1', 2, {
          type: 'assistant',
          message: { id: 'msg_a1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Bash', input: { command: 'sleep 120' } }] }
        })
      ];
      const queuedTexts = (timeline: SessionTimeline) => (timeline.getSnapshot().queuedPrompts ?? []).map((prompt) => prompt.text);
      const userTexts = (timeline: SessionTimeline) =>
        collectItems(timeline.getSnapshot().turns)
          .filter((item) => item.kind === 'message' && (item as { role?: string }).role === 'user')
          .map((item) => (item as { text: string }).text);
      async function open(lines: string[]) {
        const { root, file } = await stage(lines);
        const source = createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] }, { pollIntervalMs: 60_000 });
        const timeline = await createSessionTimeline(source, { sessionId: 'conv-claude' });
        disposers.push(() => timeline.dispose());
        return { timeline, file };
      }

      it('记录里的队列行不投影:终端里 claude 自己排着的、ACP 腿 SDK 写的保温心跳都一样', async () => {
        const { timeline } = await open([...busy, op(3, 'enqueue', '终端里排着的那句'), op(4, 'enqueue', '保温心跳:不做任何工作')]);
        expect(queuedTexts(timeline)).toEqual([]);
      });

      it('宿主同步来的那份进快照和增量;同一份再同步不推;被接走后只剩那条用户消息', async () => {
        const { timeline, file } = await open(busy);
        const seen: TimelineAfterResult[] = [];
        timeline.subscribe(timeline.getSnapshot().cursor, (result) => seen.push(result));
        timeline.syncQueuedPrompts([{ id: 'qp-1', text: QUEUED }]);
        expect(queuedTexts(timeline)).toEqual([QUEUED]);
        expect(seen.at(-1)).toMatchObject({ ok: true, batch: { queuedPrompts: [{ id: 'qp-1', text: QUEUED }] } });
        // 宿主按活状态整份同步(心跳也报一遍):内容没变就不推。
        const pushes = seen.length;
        timeline.syncQueuedPrompts([{ id: 'qp-1', text: QUEUED }]);
        expect(seen).toHaveLength(pushes);

        // 被接走:运行时那份清空,记录里出现那条用户消息。
        timeline.syncQueuedPrompts([]);
        await appendFile(file, row('u-3', 9, { type: 'user', message: { role: 'user', content: QUEUED } }) + '\n');
        await timeline.catchUp();
        expect(queuedTexts(timeline)).toEqual([]);
        expect(userTexts(timeline).filter((text) => text === QUEUED)).toHaveLength(1);
      });
    });

    describe('AskUserQuestion 的结果进结算(#6798)', () => {
      const ASK = 'toolu_ask1';
      const questions = [
        {
          question: '这次加法用哪一组数?',
          header: '选数组',
          multiSelect: false,
          options: [{ label: 'A 组', description: '17 和 25' }, { label: 'B 组', description: '31 和 44' }]
        },
        { question: '保留几位?', multiSelect: true, options: [{ label: '一位' }, { label: '两位' }] }
      ];
      const record = (uuid: string, parentUuid: string | null, rest: object) =>
        JSON.stringify({ parentUuid, isSidechain: false, uuid, timestamp: '2026-09-29T09:44:30.000Z', sessionId: SESSION_ID, ...rest });
      const asked = [
        record('9f000000-0000-4000-8000-0000000a0001', null, {
          type: 'user',
          message: { role: 'user', content: '帮我算' }
        }),
        record('9f000000-0000-4000-8000-0000000a0002', '9f000000-0000-4000-8000-0000000a0001', {
          type: 'assistant',
          message: {
            id: 'msg_ask',
            role: 'assistant',
            content: [{ type: 'tool_use', id: ASK, name: 'AskUserQuestion', input: { questions } }],
            stop_reason: 'tool_use'
          }
        })
      ];
      // 形状照 claude 2.1.278 的真实记录(ConPTY 实测):答了带 toolUseResult.answers;Esc 拒了是 is_error。
      const result = (block: object, toolUseResult: unknown) =>
        record('9f000000-0000-4000-8000-0000000a0003', '9f000000-0000-4000-8000-0000000a0002', {
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ASK, ...block }] },
          toolUseResult
        });
      const answered = result(
        { content: 'Your questions have been answered: "这次加法用哪一组数?"="A 组". You can now continue with these answers in mind.' },
        { questions, answers: { '这次加法用哪一组数?': 'A 组', '保留几位?': '一位, 两位' }, annotations: {} }
      );
      const declined = result(
        { is_error: true, content: "The user doesn't want to proceed with this tool use." },
        'User rejected tool use'
      );

      // 轮询间隔拉到一分钟:用例里的每一次读都只能来自 catchUp。
      async function open(answerableQuestions?: boolean) {
        const staged = await stage(asked);
        const source = createClaudeJsonlSource(
          { harness: 'claude', providerSessionId: SESSION_ID, roots: [staged.root] },
          { pollIntervalMs: 60_000 }
        );
        const timeline = await createSessionTimeline(source, {
          sessionId: 'conv-claude',
          ...(answerableQuestions ? { answerableQuestions } : {})
        });
        disposers.push(() => timeline.dispose());
        const settlement = () => timeline.getSnapshot().settlements.find((s) => s.itemId === ASK);
        return { ...staged, timeline, settlement };
      }

      it('问出来:整份题目原样,选择器开着', async () => {
        const { timeline, settlement } = await open(true);
        expect(settlement()).toMatchObject({
          state: 'pending',
          askedAt: Date.parse('2026-09-29T09:44:30.000Z'),
          questions: [
            { question: '这次加法用哪一组数?', header: '选数组', multiSelect: false, options: [{ optionId: 'A 组' }, { optionId: 'B 组' }] },
            { question: '保留几位?', multiSelect: true, options: [{ optionId: '一位' }, { optionId: '两位' }] }
          ]
        });
        expect(timeline.questionOpen(ASK)).toBe(true);
      });

      it('阴性对照:宿主不能代答(ACP 腿、没声明的家)⇒ 不带题目,结果照旧是在别处答了', async () => {
        const { file, timeline, settlement } = await open();
        expect(settlement()?.questions).toBeUndefined();
        await appendFile(file, answered + '\n');
        await timeline.catchUp();
        expect(settlement()).toMatchObject({ state: 'resolved', resolvedBy: null });
        expect(settlement()?.resultRecorded).toBeUndefined();
      });

      it('终端里答了:catchUp 一返回选择器就关了,结算与别的腿同一条规则 —— 已在其他端回答(没人认领、正常结束)', async () => {
        const { file, timeline, settlement } = await open(true);
        await appendFile(file, answered + '\n');
        // 阴性对照:不追就读不到(轮询一分钟一次),上面那条断言不是白绿。
        expect(timeline.questionOpen(ASK)).toBe(true);
        await Promise.all([timeline.catchUp(), timeline.catchUp()]);
        expect(timeline.questionOpen(ASK)).toBe(false);
        expect(settlement()).toMatchObject({ state: 'resolved', resultRecorded: true, resolvedBy: null });
      });

      it('Esc 拒了:同一条规则,选择器关了 —— 拒答才是「不需要回答了」', async () => {
        const { file, timeline, settlement } = await open(true);
        await appendFile(file, declined + '\n');
        await timeline.catchUp();
        expect(timeline.questionOpen(ASK)).toBe(false);
        expect(settlement()).toMatchObject({ state: 'cancelled', resultRecorded: true });
      });

      it('认领不是结果;认领后出结果照旧是「已在手机端回答」;之后放掉认领 ⇒ 不需要回答了,❌ 回到可答', async () => {
        const { file, timeline, settlement } = await open(true);
        expect(timeline.settle({ itemId: ASK, optionId: null, by: 'phone' }).ok).toBe(true);
        expect(timeline.questionOpen(ASK)).toBe(true);
        await appendFile(file, answered + '\n');
        await timeline.catchUp();
        expect(timeline.questionOpen(ASK)).toBe(false);
        expect(settlement()).toMatchObject({ state: 'resolved', resultRecorded: true, resolvedBy: 'phone' });
        timeline.releaseSettlement(ASK);
        expect(settlement()).toMatchObject({ state: 'cancelled', resultRecorded: true, resolvedBy: null });
      });

      it('还没结果时放掉认领:回 pending,可以重答', async () => {
        const { timeline, settlement } = await open(true);
        timeline.settle({ itemId: ASK, optionId: null, by: 'phone' });
        timeline.releaseSettlement(ASK);
        expect(settlement()).toMatchObject({ state: 'pending', resolvedBy: null });
        expect(timeline.questionOpen(ASK)).toBe(true);
      });
    });
  });

  it('「[Request interrupted by user]」是这一轮的收尾(turn_aborted),❌ 不是新一轮用户消息', async () => {
    const lines = await fixtureLines();
    const interrupted = JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      uuid: '926bf45d-2033-4d6c-a252-a5fb35ed6e97',
      timestamp: '2026-09-15T11:50:11.554Z',
      sessionId: SESSION_ID
    });
    const { root } = await stage([...lines, interrupted]);
    const all = await startAll(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const bounds = boundaryEntries(all);
    expect(bounds.at(-1)).toMatchObject({
      key: 'claude:926bf45d-2033-4d6c-a252-a5fb35ed6e97#end',
      at: Date.parse('2026-09-15T11:50:11.554Z'),
      boundary: { kind: 'turn_aborted' }
    });
    // 阴性对照:那句话没有变成一条用户内容。
    const userTexts = contentEntries(all)
      .map((entry) => entry.update)
      .filter((update) => update.sessionUpdate === 'user_message_chunk')
      .map((update) => (update.content as { text?: string }).text ?? '');
    expect(userTexts.some((text) => text.includes('interrupted by user'))).toBe(false);
  });

  it('stop_reason 收尾：end_turn 出边界，tool_use 不出（否则一轮被切成好几轮）', async () => {
    const { root } = await stage();
    const all = await startAll(
      createClaudeJsonlSource({ harness: 'claude', providerSessionId: SESSION_ID, roots: [root] })
    );
    const bounds = boundaryEntries(all);
    // 这份真实记录里 stop_reason 是 end_turn 的只有一条，tool_use 有四条。
    expect(bounds).toHaveLength(1);
    expect(bounds[0].boundary).toEqual({ kind: 'turn_end', stopReason: 'end_turn' });
    expect(bounds[0].key.endsWith('#end')).toBe(true);

    // 阳性对照：这份记录里确实有 tool_use 的 assistant 记录 —— 上面那个 1 不是"整条通道没跑起来"。
    const lines = await fixtureLines();
    const stops = lines
      .map((line) => JSON.parse(line) as { message?: { stop_reason?: string } })
      .map((record) => record.message?.stop_reason)
      .filter((reason): reason is string => typeof reason === 'string');
    expect(stops.filter((reason) => reason === 'tool_use').length).toBeGreaterThan(0);
    expect(stops.filter((reason) => reason === 'end_turn')).toHaveLength(1);
  });

});
