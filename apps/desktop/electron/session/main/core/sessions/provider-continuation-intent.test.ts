// @@@3890⑭ `.gugu-continuations` 的崩溃残留与「一个坏文件废掉整趟」。
//
// 这个目录跟着 task worktree 一直存在，而 provider continuation intent 是 fork-capture 把「续接会话」
// 绑回既有 conversation 的唯一依据。两处问题：
//  ① 读侧原本是 `Promise.all(names.map(parseIntent))` —— 任意一个文件解析不过就让整趟 list 抛，于是
//     一个坏文件废掉这个 task 的**全部**续接绑定（包括完好的那些），而且没人会去修它。
//  ② 写侧本来就是 tmp+rename（所以 `.json` 永远不会半截，这点不用改），但进程死在 writeFile 与 rename
//     之间会留下 `<conv>.json.<uuid>.tmp`：不毒读侧，却永远没人删，每崩一次多一个。
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeTranscriptDirFor } from './fork-lineage';
import {
  listProviderContinuationIntents,
  recordProviderContinuationIntent,
} from './provider-continuation-intent';

vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const CONV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('#3890⑭ provider continuation intent 的残留与坏文件', () => {
  const origConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let configDir: string;
  let sessionPath: string;

  const intentDir = (): string => path.join(claudeTranscriptDirFor(sessionPath), '.gugu-continuations');

  beforeEach(async () => {
    // macOS 的 tmpdir 是 /var/... 而 /var 是指向 /private/var 的符号链接，而
    // recordProviderContinuationIntent 内部会对 taskPath 做 realpath —— 两侧不都解，算出来的目录
    // 在 macOS 上就对不上（Linux 上却一路绿）。两侧都 realpath。
    configDir = await realpath(await mkdtemp(path.join(tmpdir(), 'gugu-cont-cfg-')));
    sessionPath = await realpath(await mkdtemp(path.join(tmpdir(), 'gugu-cont-task-')));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(async () => {
    if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
    await rm(configDir, { recursive: true, force: true });
    await rm(sessionPath, { recursive: true, force: true });
  });

  it('一个坏 intent 只丢它自己，其余续接绑定照常拿得到（修复前:整趟抛，全部丢）', async () => {
    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_A, sourceProviderSessionId: 's-a' });
    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_B, sourceProviderSessionId: 's-b' });
    await writeFile(path.join(intentDir(), 'broken.json'), '{"version":1,"kind":"prov', 'utf8');

    const intents = await listProviderContinuationIntents(sessionPath);
    expect(intents.map((intent) => intent.sessionId).sort()).toEqual([CONV_A, CONV_B]);
  });

  it('结构完整但字段非法的 intent 同样只丢它自己，不静默换成空结果', async () => {
    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_A, sourceProviderSessionId: 's-a' });
    await writeFile(
      path.join(intentDir(), 'wrong-version.json'),
      JSON.stringify({ version: 2, kind: 'provider-continuation' }),
      'utf8'
    );
    expect((await listProviderContinuationIntents(sessionPath)).map((i) => i.sessionId)).toEqual([CONV_A]);
  });

  it('崩在 writeFile 与 rename 之间留下的 .tmp：不进读侧，且下一次成功发布就带走它', async () => {
    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_A, sourceProviderSessionId: 's-a' });
    // 上一轮进程死在 rename 之前留下的半成品。
    const orphan = path.join(intentDir(), `${CONV_A}.json.11111111-1111-4111-8111-111111111111.tmp`);
    await writeFile(orphan, '{"version":1,"kind":"provider-cont', 'utf8');

    // 它不匹配 `.json` 后缀 → 读侧看不见它（所以它从来不是「坏文件」那条问题）。
    expect((await listProviderContinuationIntents(sessionPath)).map((i) => i.sessionId)).toEqual([CONV_A]);

    // 同一个 conversation 下一次成功发布把它带走：回收由正常写路径驱动，不靠 TTL / 启动清扫器。
    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_A, sourceProviderSessionId: 's-a2' });
    expect((await readdir(intentDir())).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('只清自己目标名下的半成品，不碰别的 conversation 的', async () => {
    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_A, sourceProviderSessionId: 's-a' });
    await mkdir(intentDir(), { recursive: true });
    const otherOrphan = path.join(intentDir(), `${CONV_B}.json.22222222-2222-4222-8222-222222222222.tmp`);
    await writeFile(otherOrphan, 'x', 'utf8');

    await recordProviderContinuationIntent({ sessionPath, sessionId: CONV_A, sourceProviderSessionId: 's-a2' });
    expect((await readdir(intentDir())).filter((n) => n.endsWith('.tmp'))).toEqual([path.basename(otherOrphan)]);
  });
});
