/**
 * 时间线存档里的工具图只存位置(#980)。
 *
 * 判据:存档里没有图的正文(它本来就在记录里),装回来以后端上看到的时间线与整份重读一模一样,每一张图照样
 * 取得到、逐字相同;位置对不上(记录被改写)时如实说取不到 —— 与图不在了是同一种降级,❌ 交出别的字节。
 *
 * 用真的记录源与真文件:位置是字节偏移,假源把尾读器与「一行里有多字节字符」这两样全绕过去了。
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open as openFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionTimeline } from './contract';
import { createClaudeJsonlSource } from './sources/claude-jsonl';
import { createCodexJsonlSource } from './sources/codex-jsonl';
import { createSessionTimeline, type TimelineArchive } from './timeline';
import { trimTurnsForTransport } from './transport-trim';
import { collectItems } from './test-support';
import type { ToolCallItem } from '../acp/models/turns/tool-calls';

const THREAD_ID = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
const CLAUDE_ID = 'f1b2c3d4-0000-4000-8000-0000000000aa';

const disposers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.();
});

/** 一张像样大小的图:随机字节的 base64,正文里没有任何重复可让「找错位置」碰巧对上。 */
const picture = (bytes = 60_000) => randomBytes(bytes).toString('base64');

const at = (second: number) => `2026-10-30T01:00:${String(second).padStart(2, '0')}.000Z`;
const codexLine = (second: number, type: string, payload: unknown) => JSON.stringify({ timestamp: at(second), type, payload });
const codexTurn = (second: number, id: string, prompt: string) => [
  codexLine(second, 'event_msg', { type: 'task_started', turn_id: id }),
  codexLine(second, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }),
];
const codexShots = (second: number, callId: string, shots: string[]) => [
  codexLine(second, 'response_item', { type: 'function_call', name: 'app_check', namespace: 'mcp__gugu', arguments: '{}', call_id: callId }),
  // 图前面有一段中文:位置是字节偏移,按字符算会差出一截。
  codexLine(second, 'response_item', { type: 'function_call_output', call_id: callId, output: [
    { type: 'input_text', text: '截图两张,中文说明在图前面' },
    ...shots.map((shot) => ({ type: 'input_image', image_url: `data:image/png;base64,${shot}`, detail: 'auto' })),
  ] }),
];
const codexEnd = (second: number, id: string) => codexLine(second, 'event_msg', { type: 'task_complete', turn_id: id });

async function stageCodex(lines: string[]): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'archive-images-'));
  disposers.push(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, '2026', '10', '30');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-30T01-00-00-${THREAD_ID}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n');
  return { root, file };
}

async function openCodex(root: string, archive?: TimelineArchive | null): Promise<SessionTimeline> {
  const source = createCodexJsonlSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] }, { pollIntervalMs: 50 });
  const timeline = await createSessionTimeline(source, { sessionId: 'conv-images', archive });
  disposers.push(() => timeline.dispose());
  return timeline;
}

function toolsOf(timeline: SessionTimeline): ToolCallItem[] {
  return collectItems(timeline.getSnapshot({ limit: 1_000 }).turns).filter((item): item is ToolCallItem => item.kind.endsWith('-tool-call'));
}

/** 端上看到的那一份(图只剩类型和字数),去掉发布序号。 */
function seen(timeline: SessionTimeline): string {
  return JSON.stringify(trimTurnsForTransport(timeline.getSnapshot({ limit: 1_000 }).turns), (key, value) => (key === 'seq' ? undefined : value));
}

/** 一条收尾的轮里两张图 + 还在跑的一轮里一张图。 */
async function twoTurns() {
  const done = [picture(), picture()];
  const running = picture();
  const staged = await stageCodex([
    ...codexTurn(1, 'turn-1', '看看页面'),
    ...codexShots(2, 'call_done', done),
    codexEnd(3, 'turn-1'),
    ...codexTurn(4, 'turn-2', '再看一次'),
    ...codexShots(5, 'call_running', [running]),
  ]);
  return { staged, done, running };
}

describe('时间线存档里的工具图只存位置', () => {
  it('收尾的轮里的图不进存档;装回来端上看到的与整份重读一样,每张图逐字取得回来', async () => {
    const { staged, done, running } = await twoTurns();
    const before = await openCodex(staged.root);
    const archive = await before.archive?.();
    before.dispose();
    const json = JSON.stringify(archive);

    for (const shot of done) expect(json).not.toContain(shot);
    // 还在跑的那一轮照原样存:它的条目还会被更新,更新是在原图上折的。位置也记下,收了尾的下一代存档才换得掉。
    expect(json).toContain(running);
    expect(archive!.images.map(([, refs]) => refs.length)).toEqual([2, 1]);

    const resumed = await openCodex(staged.root, archive);
    const full = await openCodex((await stageCodex((await readFile(staged.file, 'utf8')).split('\n').filter(Boolean))).root);
    expect(seen(resumed)).toBe(seen(full));

    const [restored] = toolsOf(resumed);
    expect(restored).not.toHaveProperty('images');
    expect(restored.imageRefs).toEqual(done.map((shot) => ({ mimeType: 'image/png', chars: shot.length })));
    for (const [index, shot] of done.entries()) {
      expect(await resumed.toolImage!({ itemId: restored.id, index })).toEqual({ ok: true, image: { mimeType: 'image/png', data: shot } });
      expect(await full.toolImage!({ itemId: restored.id, index })).toEqual({ ok: true, image: { mimeType: 'image/png', data: shot } });
    }
    expect(await resumed.toolImage!({ itemId: restored.id, index: 2 })).toMatchObject({ ok: false, code: 'no_such_image' });
  });

  it('存档变小:图的正文一字不存', async () => {
    const { staged, done } = await twoTurns();
    const timeline = await openCodex(staged.root);
    const archive = await timeline.archive?.();
    const bytes = JSON.stringify(archive).length;
    const images = done.reduce((sum, shot) => sum + shot.length, 0);
    // 存档里还有那张在跑的图(约 80K 字)与正文;收尾那两张(约 160K 字)不在里面。
    expect(bytes).toBeLessThan(images);
  });

  it('装回来再存一代:位置照样带着;当时还在跑、后来收了尾的那一轮与新长出来的轮,图也换成位置', async () => {
    const { staged, done, running } = await twoTurns();
    const first = await openCodex(staged.root);
    const archive = await first.archive?.();
    first.dispose();

    const later = picture();
    await appendFile(staged.file, [codexEnd(6, 'turn-2'), ...codexTurn(7, 'turn-3', '第三次'), ...codexShots(8, 'call_later', [later]), codexEnd(9, 'turn-3')].join('\n') + '\n');
    const second = await openCodex(staged.root, archive);
    const again = await second.archive?.();
    second.dispose();
    const json = JSON.stringify(again);
    for (const shot of [...done, running, later]) expect(json).not.toContain(shot);

    const third = await openCodex(staged.root, again);
    const tools = toolsOf(third);
    expect(tools.every((tool) => !tool.images)).toBe(true);
    const read: string[] = [];
    for (const tool of tools) {
      for (const [index] of (tool.imageRefs ?? []).entries()) {
        const found = await third.toolImage!({ itemId: tool.id, index });
        if (found.ok) read.push(found.image.data);
      }
    }
    expect(read).toEqual([...done, running, later]);
  });

  it('记录原地被改写、位置上已不是那张图 ⇒ 如实说取不到(与图不在了同一种降级),❌ 交出别的字节', async () => {
    const { staged } = await twoTurns();
    const before = await openCodex(staged.root);
    const archive = await before.archive?.();
    before.dispose();
    const [, refs] = archive!.images[0];

    // 同一个 inode、同样长短,只把第一张图那段字节换掉:续读点照样成立,图不再是那张。
    const handle = await openFile(staged.file, 'r+');
    await handle.write(Buffer.from('A'.repeat(refs[0].chars)), 0, refs[0].chars, refs[0].start);
    await handle.close();

    const resumed = await openCodex(staged.root, archive);
    const [restored] = toolsOf(resumed);
    expect(await resumed.toolImage!({ itemId: restored.id, index: 0 })).toMatchObject({ ok: false, code: 'no_such_image' });
    // 没动过的那张照样取得到。
    expect(await resumed.toolImage!({ itemId: restored.id, index: 1 })).toMatchObject({ ok: true });
  });

  it('超过上限的一张不去读盘,回 too_large(手机说「在桌面上看」)', async () => {
    const { staged, done } = await twoTurns();
    const before = await openCodex(staged.root);
    const archive = await before.archive?.();
    before.dispose();
    const resumed = await openCodex(staged.root, archive);
    const [restored] = toolsOf(resumed);
    expect(await resumed.toolImage!({ itemId: restored.id, index: 0, maxChars: done[0].length - 1 })).toMatchObject({ ok: false, code: 'too_large' });
  });

  it('claude 记录同样只存位置', async () => {
    const shot = picture();
    const row = (uuid: string, second: number, body: Record<string, unknown>) =>
      JSON.stringify({ parentUuid: null, isSidechain: false, uuid, timestamp: at(second), sessionId: CLAUDE_ID, ...body });
    const lines = [
      row('u-1', 1, { type: 'user', message: { role: 'user', content: '截个图' } }),
      row('a-1', 2, { type: 'assistant', message: { id: 'msg_a1', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_shot', name: 'mcp__gugu__app_check', input: {} }] } }),
      row('u-2', 3, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_shot', content: [
        { type: 'text', text: '中文说明在图前面' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shot } },
      ] }] } }),
      row('a-2', 4, { type: 'assistant', message: { id: 'msg_a2', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '看到了' }] } }),
      row('u-3', 5, { type: 'user', message: { role: 'user', content: '下一轮' } }),
    ];
    const root = await mkdtemp(join(tmpdir(), 'archive-images-claude-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '-work-repo'), { recursive: true });
    await writeFile(join(root, '-work-repo', `${CLAUDE_ID}.jsonl`), lines.join('\n') + '\n');
    const openClaude = async (archive?: TimelineArchive | null) => {
      const source = createClaudeJsonlSource({ harness: 'claude', providerSessionId: CLAUDE_ID, roots: [root] }, { pollIntervalMs: 50 });
      const timeline = await createSessionTimeline(source, { sessionId: 'conv-claude-images', archive });
      disposers.push(() => timeline.dispose());
      return timeline;
    };

    const before = await openClaude();
    const archive = await before.archive?.();
    before.dispose();
    expect(JSON.stringify(archive)).not.toContain(shot);

    const resumed = await openClaude(archive);
    const tool = toolsOf(resumed).find((item) => item.toolCallId === 'toolu_shot')!;
    expect(await resumed.toolImage!({ itemId: tool.id, index: 0 })).toEqual({ ok: true, image: { mimeType: 'image/png', data: shot } });
  });
});
