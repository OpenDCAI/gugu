import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireNativeHome } from '@gugu/session-plugins/agents';
import { combineLocalUsage } from './combine-local-usage';
import { foldTokenEntries } from './token-fold';
import { localDayOf } from './local-day';
import { packParsedLogFile, parseLogFile, unpackParsedLogFile } from './token-log-file';
import { claudeTokenReader } from './token-readers/claude';
import { codexTokenReader } from './token-readers/codex';
import {
  collectTokenEntries,
  configRootsFor,
  createParsedFileMemory,
  hydrateParsedFileMemory,
  type CachedLogFileSave,
} from './token-scan';

// ── 真实形状的样本行(2026-09 本机日志实测字段,数值为造)──────────────────────────────

function claudeAssistant(opts: {
  messageId: string;
  requestId: string;
  ts: string;
  model?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  text?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    requestId: opts.requestId,
    uuid: `${opts.messageId}-${Math.random()}`,
    message: {
      id: opts.messageId,
      model: opts.model ?? 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: opts.text ?? 'hi' }],
      usage: {
        input_tokens: opts.usage.input,
        output_tokens: opts.usage.output,
        cache_read_input_tokens: opts.usage.cacheRead,
        cache_creation_input_tokens: opts.usage.cacheWrite,
        service_tier: 'standard',
      },
    },
  });
}

const claudeUser = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: '2026-09-23T10:00:00.000Z', message: { role: 'user', content: text } });

function codexTurnContext(model: string, ts: string): string {
  return JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { model, cwd: '/repo' } });
}

function codexTokenCount(
  ts: string,
  total: { input: number; cached: number; cacheWrite?: number; output: number; reasoning?: number }
): string {
  const usage = {
    input_tokens: total.input,
    cached_input_tokens: total.cached,
    ...(total.cacheWrite !== undefined && { cache_write_input_tokens: total.cacheWrite }),
    output_tokens: total.output,
    reasoning_output_tokens: total.reasoning ?? 0,
    total_tokens: total.input + total.output,
  };
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } },
  });
}

const sum = (e: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  e.input + e.output + e.cacheRead + e.cacheWrite;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gugu-usage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claude 读取器', () => {
  it('四类 token 字段对位,空用量与非 assistant 行不出条目', () => {
    const entry = claudeTokenReader.readLine(
      JSON.parse(
        claudeAssistant({
          messageId: 'msg_1',
          requestId: 'req_1',
          ts: '2026-09-23T10:00:00.000Z',
          usage: { input: 2, output: 2633, cacheRead: 35676, cacheWrite: 64478 },
        })
      ),
      null
    );
    expect(entry).toEqual({
      key: 'claude:msg_1:req_1',
      ts: Date.parse('2026-09-23T10:00:00.000Z'),
      model: 'claude-opus-5-5',
      input: 2,
      output: 2633,
      cacheRead: 35676,
      cacheWrite: 64478,
    });
    expect(claudeTokenReader.readLine(JSON.parse(claudeUser('x')), null)).toBeNull();
    const zero = claudeAssistant({
      messageId: 'msg_0',
      requestId: 'req_0',
      ts: '2026-09-23T10:00:00.000Z',
      model: '<synthetic>',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(claudeTokenReader.readLine(JSON.parse(zero), null)).toBeNull();
  });

  it('同一条消息写了三行 → 汇总里只算一次(message.id + requestId 去重)', async () => {
    const path = join(dir, 's.jsonl');
    const line = (text: string) =>
      claudeAssistant({
        messageId: 'msg_dup',
        requestId: 'req_dup',
        ts: '2026-09-23T10:00:00.000Z',
        text,
        usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      });
    writeFileSync(path, [claudeUser('go'), line('a'), line('b'), line('c'), ''].join('\n'));
    const parsed = await parseLogFile(path, claudeTokenReader);
    expect(parsed.entries).toHaveLength(3);
    const day = localDayOf(Date.parse('2026-09-23T10:00:00.000Z'));
    const snapshot = combineLocalUsage({
      from: day,
      to: day,
      sessions: [],
      intervals: [],
      tokenRows: foldTokenEntries(parsed.entries.map((e) => ({ ...e, provider: 'claude', providerSessionId: 's1' }))),
    });
    expect(snapshot.engines).toHaveLength(1);
    expect(snapshot.engines[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 40,
      models: { 'claude-opus-5-5': 100 },
    });
  });

  it('按会话 id 找文件:主文件 + 子 agent 文件,别的会话不碰', async () => {
    const projects = join(dir, '.claude', 'projects');
    mkdirSync(join(projects, '-repo-a', 'sid-1', 'subagents'), { recursive: true });
    mkdirSync(join(projects, '-repo-b'), { recursive: true });
    writeFileSync(join(projects, '-repo-a', 'sid-1.jsonl'), '');
    writeFileSync(join(projects, '-repo-a', 'sid-1', 'subagents', 'agent-x.jsonl'), '');
    writeFileSync(join(projects, '-repo-a', 'sid-1', 'subagents', 'agent-x.meta.json'), '{}');
    writeFileSync(join(projects, '-repo-b', 'someone-else.jsonl'), '');
    writeFileSync(join(projects, '-repo-b', 'sid-2.jsonl'), '');
    const found = await claudeTokenReader.locate([join(dir, '.claude'), join(dir, 'missing')], new Set(['sid-1', 'sid-2']));
    expect(found.get('sid-1')?.sort()).toEqual(
      [join(projects, '-repo-a', 'sid-1.jsonl'), join(projects, '-repo-a', 'sid-1', 'subagents', 'agent-x.jsonl')].sort()
    );
    expect(found.get('sid-2')).toEqual([join(projects, '-repo-b', 'sid-2.jsonl')]);
    expect(found.has('someone-else')).toBe(false);
  });
});

describe('codex 读取器', () => {
  it('累计值取差;input 扣掉缓存命中与缓存写入;output 已含 reasoning 不再加;模型取最近的 turn_context', async () => {
    const path = join(dir, 'rollout-2026-09-23T05-19-52-01a0ce35-43e0-7db2-b762-49dd6f882b08.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-09-23T12:19:52.000Z', payload: { id: 'x' } }),
        codexTurnContext('gpt-5.6-terra', '2026-09-23T12:19:54.000Z'),
        codexTokenCount('2026-09-23T12:20:05.000Z', { input: 19930, cached: 0, cacheWrite: 19927, output: 266, reasoning: 21 }),
        // codex 偶尔把同一条累计值连写两遍 —— 差为 0,不出条目。
        codexTokenCount('2026-09-23T12:20:05.000Z', { input: 19930, cached: 0, cacheWrite: 19927, output: 266, reasoning: 21 }),
        codexTurnContext('gpt-5.5', '2026-09-23T12:21:00.000Z'),
        codexTokenCount('2026-09-23T12:21:18.000Z', { input: 40636, cached: 20473, cacheWrite: 20157, output: 483, reasoning: 199 }),
        '',
      ].join('\n')
    );
    const { entries } = await parseLogFile(path, codexTokenReader);
    expect(entries.map(({ key: _key, ts: _ts, ...rest }) => rest)).toEqual([
      { model: 'gpt-5.6-terra', input: 3, output: 266, cacheRead: 0, cacheWrite: 19927 },
      { model: 'gpt-5.5', input: 20706 - 20473 - 230, output: 217, cacheRead: 20473, cacheWrite: 230 },
    ]);
    // 四类之和 = 这一段的 input + output(total_tokens 的差)。
    expect(sum(entries[1])).toBe(40636 + 483 - (19930 + 266));
  });

  it('旧版没有 cache_write 字段按 0;累计值变小(续接/重置)从 0 起算', async () => {
    const path = join(dir, 'r.jsonl');
    writeFileSync(
      path,
      [
        codexTurnContext('gpt-5', '2026-09-23T12:00:00.000Z'),
        codexTokenCount('2026-09-23T12:01:00.000Z', { input: 1000, cached: 400, output: 50 }),
        codexTokenCount('2026-09-23T12:02:00.000Z', { input: 300, cached: 100, output: 10 }),
        '',
      ].join('\n')
    );
    const { entries } = await parseLogFile(path, codexTokenReader);
    expect(entries.map(({ input, output, cacheRead, cacheWrite }) => ({ input, output, cacheRead, cacheWrite }))).toEqual([
      { input: 600, output: 50, cacheRead: 400, cacheWrite: 0 },
      { input: 200, output: 10, cacheRead: 100, cacheWrite: 0 },
    ]);
  });

  it('按文件名里的会话 id 找 rollout,含归档目录', async () => {
    const sid = '01a0ce35-43e0-7db2-b762-49dd6f882b08';
    const day = join(dir, '.codex', 'sessions', '2026', '09', '23');
    mkdirSync(day, { recursive: true });
    mkdirSync(join(dir, '.codex', 'archived_sessions'), { recursive: true });
    writeFileSync(join(day, `rollout-2026-09-23T05-19-52-${sid}.jsonl`), '');
    writeFileSync(join(day, 'rollout-2026-09-23T05-19-52-11111111-1111-1111-1111-111111111111.jsonl'), '');
    writeFileSync(join(dir, '.codex', 'archived_sessions', `rollout-2026-09-01T01-00-00-${sid}.jsonl`), '');
    const found = await codexTokenReader.locate([join(dir, '.codex')], new Set([sid.toUpperCase()]));
    expect(found.get(sid.toUpperCase())).toHaveLength(2);
  });
});

describe('日志文件的增量读取与缓存', () => {
  it('末尾半行不算;接着读与一口气读完得到同一组条目(含 codex 的累计状态)', async () => {
    const path = join(dir, 'grow.jsonl');
    const first = codexTokenCount('2026-09-23T12:01:00.000Z', { input: 1000, cached: 400, output: 50 });
    const second = codexTokenCount('2026-09-23T12:02:00.000Z', { input: 1500, cached: 900, output: 70 });
    writeFileSync(path, `${codexTurnContext('gpt-5', '2026-09-23T12:00:00.000Z')}\n${first}\n${second.slice(0, 20)}`);
    const partial = await parseLogFile(path, codexTokenReader);
    expect(partial.entries).toHaveLength(1);

    appendFileSync(path, `${second.slice(20)}\n`);
    const resumed = await parseLogFile(path, codexTokenReader, unpackParsedLogFile(packParsedLogFile(partial))!);
    const full = await parseLogFile(path, codexTokenReader);
    expect(resumed).toEqual(full);
    expect(full.entries[1]).toMatchObject({ input: 0, cacheRead: 500, output: 20, model: 'gpt-5' });
  });

  it('多字节字符跨块也不会把偏移算错', async () => {
    const path = join(dir, 'utf8.jsonl');
    const lines = Array.from({ length: 2000 }, (_, i) =>
      claudeAssistant({
        messageId: `m${i}`,
        requestId: `r${i}`,
        ts: '2026-09-23T10:00:00.000Z',
        text: '咕咕'.repeat(400),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      })
    );
    writeFileSync(path, `${lines.join('\n')}\n`);
    const parsed = await parseLogFile(path, claudeTokenReader);
    expect(parsed.entries).toHaveLength(2000);
    expect(parsed.offset).toBe(Buffer.byteLength(`${lines.join('\n')}\n`));
  });

  it('collectTokenEntries:第二次全部命中缓存,文件变长只读新增那段', async () => {
    const claudeRoot = join(dir, 'home', '.claude');
    const projectDir = join(claudeRoot, 'projects', '-repo');
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, 'sid-1.jsonl');
    const line = (i: number) =>
      claudeAssistant({
        messageId: `m${i}`,
        requestId: `r${i}`,
        ts: '2026-09-23T10:00:00.000Z',
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      });
    writeFileSync(path, `${line(1)}\n`);
    const saved: CachedLogFileSave[] = [];
    const memory = createParsedFileMemory();
    const options = {
      providerSessions: [
        { provider: 'claude', providerSessionId: 'sid-1' },
        { provider: 'opencode', providerSessionId: 'no-reader' },
      ],
      readers: [claudeTokenReader, codexTokenReader],
      rootsByProvider: { claude: [claudeRoot] },
      memory,
      onSave: (row: CachedLogFileSave) => saved.push(row),
    };

    const first = await collectTokenEntries(options);
    expect(first.stats).toMatchObject({ files: 1, fullParses: 1, cacheHits: 0 });
    expect(first.entries).toHaveLength(1);
    expect(saved).toHaveLength(1);

    const second = await collectTokenEntries(options);
    expect(second.stats).toMatchObject({ files: 1, cacheHits: 1, bytesRead: 0 });
    expect(second.entries).toEqual(first.entries);
    expect(saved).toHaveLength(1); // 命中不写库

    // 新的内存层(线程被收过、重起)从库缓存灌回来,照样命中,不重读文件。
    const rehydrated = createParsedFileMemory();
    hydrateParsedFileMemory(rehydrated, saved);
    const fromDb = await collectTokenEntries({ ...options, memory: rehydrated });
    expect(fromDb.stats).toMatchObject({ cacheHits: 1, bytesRead: 0 });
    expect(fromDb.entries).toEqual(first.entries);

    const appended = `${line(2)}\n`;
    appendFileSync(path, appended);
    const third = await collectTokenEntries(options);
    // 只读了新增的那一行,不是整份。
    expect(third.stats).toMatchObject({ resumed: 1, fullParses: 0, bytesRead: Buffer.byteLength(appended) });
    expect(third.entries.map((e) => e.key)).toEqual(['claude:m1:r1', 'claude:m2:r2']);
  });
});

describe('configRootsFor', () => {
  it('影子 home 的覆盖、用户环境的覆盖、home 下默认目录都列,去重', () => {
    expect(
      configRootsFor(requireNativeHome('claude'), { root: '/shadow', env: { CLAUDE_CONFIG_DIR: '/shadow/cfg' } }, {
        CLAUDE_CONFIG_DIR: '/user/cfg',
      })
    ).toEqual(['/shadow/cfg', '/user/cfg', '/shadow/.claude']);
    expect(configRootsFor(requireNativeHome('codex'), { root: '/home/u', env: {} }, {})).toEqual(['/home/u/.codex']);
  });
});
