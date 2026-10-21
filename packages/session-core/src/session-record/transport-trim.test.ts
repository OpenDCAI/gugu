import { describe, expect, it } from 'vitest';

import type { ToolNode, TranscriptItem, TranscriptTurn } from '../acp/client';
import type { TimelineSnapshot, TurnPatch } from './contract';
import {
  TRANSPORT_PAYLOAD_BUDGET,
  TRANSPORT_TEXT_LIMIT,
  trimAfterResultForTransport,
  trimBatchForTransport,
  trimOlderForTransport,
  trimSnapshotForTransport,
  trimTurnsForTransport
} from './transport-trim';

const LIMIT = 16;

function execTool(id: string, fields: Partial<Record<string, unknown>> = {}): ToolNode {
  return {
    kind: 'execute-tool-call',
    id,
    seq: 1,
    toolCallId: id,
    title: 'cat big.txt',
    status: 'done',
    ...fields
  } as ToolNode;
}

function turn(id: string, items: TranscriptItem[]): TranscriptTurn {
  return { id, role: 'assistant', startedAt: 1, items, outcome: null } as unknown as TranscriptTurn;
}

describe('发给手机那一份的裁剪', () => {
  it('超过上限的工具输出被裁到上限，并如实报出少了多少字', () => {
    const output = 'x'.repeat(LIMIT + 40);
    const [trimmed] = trimTurnsForTransport([turn('t1', [execTool('a', { outputText: output })])], LIMIT);
    const tool = trimmed.items[0] as ToolNode & { outputText: string; trimmedChars: number };

    expect(tool.outputText).toHaveLength(LIMIT);
    expect(tool.outputText).toBe(output.slice(0, LIMIT));
    // 留痕：看不出来的截断等于给了一个错的读数。
    expect(tool.trimmedChars).toBe(40);
  });

  it('阴控：没超上限的那一份原样返回**同一个引用**（❌ 不许平白重建一棵树）', () => {
    const turns = [turn('t1', [execTool('a', { outputText: 'x'.repeat(LIMIT) })])];
    expect(trimTurnsForTransport(turns, LIMIT)).toBe(turns);
    // 判据能判假的对照就在上一条：同样的输入多一个字符就会被裁。
    const longer = [turn('t1', [execTool('a', { outputText: 'x'.repeat(LIMIT + 1) })])];
    expect(trimTurnsForTransport(longer, LIMIT)).not.toBe(longer);
  });

  it('四类大字段都裁：工具的入参/原始输出/文本输出，以及改文件的新旧文本', () => {
    const big = 'y'.repeat(LIMIT + 5);
    const [trimmed] = trimTurnsForTransport(
      [
        turn('t1', [
          execTool('a', { rawInput: big, rawOutput: big, outputText: big }),
          { ...execTool('b'), kind: 'modify-file-tool-call', path: '/f', oldText: big, newText: big } as ToolNode
        ])
      ],
      LIMIT
    );
    const exec = trimmed.items[0] as Record<string, unknown>;
    const modify = trimmed.items[1] as Record<string, unknown>;
    expect([exec.rawInput, exec.rawOutput, exec.outputText]).toEqual([
      big.slice(0, LIMIT),
      big.slice(0, LIMIT),
      big.slice(0, LIMIT)
    ]);
    expect(exec.trimmedChars).toBe(15); // 三格各少 5
    expect([modify.oldText, modify.newText]).toEqual([big.slice(0, LIMIT), big.slice(0, LIMIT)]);
  });

  it('嵌在工具组里的子调用照裁 —— 大输出常常挂在某一条子调用上', () => {
    const big = 'z'.repeat(LIMIT + 3);
    const group = {
      kind: 'tool-group',
      id: 'g',
      seq: 1,
      label: '一组命令',
      groupKind: 'execute',
      status: 'done',
      children: [execTool('child', { outputText: big })]
    } as unknown as ToolNode;
    const [trimmed] = trimTurnsForTransport([turn('t1', [group])], LIMIT);
    const child = (trimmed.items[0] as unknown as { children: Record<string, unknown>[] }).children[0];
    expect(child.outputText).toHaveLength(LIMIT);
    expect(child.trimmedChars).toBe(3);
  });

  it('❌ 不碰人写的消息：只有工具带回来的大块内容才裁', () => {
    const long = 'w'.repeat(LIMIT + 100);
    const message = { kind: 'message', id: 'm', seq: 1, role: 'user', text: long } as unknown as TranscriptItem;
    const turns = [turn('t1', [message])];
    expect(trimTurnsForTransport(turns, LIMIT)).toBe(turns);
  });

  it('快照与增量两条路都裁（首屏那条只是推送那条的一个特例）', () => {
    const big = 'q'.repeat(LIMIT + 7);
    const snapshot = {
      turns: [turn('t1', [execTool('a', { outputText: big })])],
      cursor: { epoch: 'e', seq: 3 },
      hasOlder: false,
      settlements: {}
    } as unknown as TimelineSnapshot;

    const trimmedSnapshot = trimSnapshotForTransport(snapshot, LIMIT);
    expect((trimmedSnapshot.turns[0].items[0] as Record<string, unknown>).outputText).toHaveLength(LIMIT);

    const patch = {
      id: 't1',
      role: 'assistant',
      startedAt: 1,
      outcome: null,
      itemIds: ['a'],
      items: [execTool('a', { outputText: big })]
    } as unknown as TurnPatch;
    const after = trimAfterResultForTransport(
      { ok: true, batch: { from: 0, cursor: { epoch: 'e', seq: 4 }, turns: [patch], removedTurnIds: [], settlements: [] } },
      LIMIT
    );
    if (!after.ok) throw new Error('unreachable');
    expect((after.batch.turns[0].items[0] as Record<string, unknown>).outputText).toHaveLength(LIMIT);
    // 世代翻篇那一支带的是整份快照，同样要裁。
    const reset = trimAfterResultForTransport({ ok: false, reset: 'epoch_changed', snapshot }, LIMIT);
    if (reset.ok) throw new Error('unreachable');
    expect((reset.snapshot.turns[0].items[0] as Record<string, unknown>).outputText).toHaveLength(LIMIT);
  });

  it('出厂上限是 8K —— 这是产品口径，改它要连着「桌面看完整」那句话一起改', () => {
    expect(TRANSPORT_TEXT_LIMIT).toBe(8_192);
  });
});


/**
 * 总量预算。逐字段裁只挡得住「一条输出几十万字」；导入进来的 CLI 会话是「单条不长、一轮里几十上百条」，
 * 那种胖法逐字段一个字都裁不掉（实测一份 39MB 的真记录裁完仍有 0.28~0.81MB，只省了 10%）。
 */
describe('首屏总量预算', () => {
  const snapshotOf = (turns: TranscriptTurn[], hasOlder = false): TimelineSnapshot =>
    ({ cursor: { epoch: 'e1', seq: 1 }, turns, settlements: [], hasOlder }) as unknown as TimelineSnapshot;

  /** 一轮 ≈ `size` 字节，且每条都在 8K 以下 —— 逐字段裁剪对它无能为力。 */
  const fatTurn = (id: string, items: number): TranscriptTurn =>
    turn(
      id,
      Array.from({ length: items }, (_, i) => execTool(`${id}-${i}`, { outputText: 'x'.repeat(1_000) }))
    );

  it('超预算 → 从最旧的那头丢，并把 hasOlder 抬起来', () => {
    const turns = Array.from({ length: 20 }, (_, i) => fatTurn(`t${i}`, 40));
    const before = JSON.stringify(turns).length;
    // 阳性前提：这一份确实逐字段裁不动（没有哪一条超过 8K），所以下面测的是总量闸本身。
    expect(JSON.stringify(trimTurnsForTransport(turns)).length).toBe(before);
    expect(before).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);

    const fitted = trimSnapshotForTransport(snapshotOf(turns));
    expect(JSON.stringify(fitted.turns).length).toBeLessThanOrEqual(TRANSPORT_PAYLOAD_BUDGET);
    expect(fitted.turns.length).toBeLessThan(turns.length);
    expect(fitted.hasOlder).toBe(true);
    // 留下的必须是**最新**的那一段,❌ 不是最旧的。
    expect(fitted.turns.at(-1)!.id).toBe('t19');
  });

  it('装得下就一个字不动 —— 同一个引用原样返回', () => {
    const snapshot = snapshotOf([fatTurn('t0', 2)]);
    expect(trimSnapshotForTransport(snapshot)).toBe(snapshot);
  });

  it('最新那一轮自己就超预算 → 照样发出去,❌ 不许发成空的', () => {
    const huge = fatTurn('big', 400);
    expect(JSON.stringify([huge]).length).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);
    const fitted = trimSnapshotForTransport(snapshotOf([fatTurn('old', 40), huge]));
    expect(fitted.turns.map((t) => t.id)).toEqual(['big']);
    expect(fitted.hasOlder).toBe(true);
  });

  it('往前翻的那一页同样受预算约束,且丢过就说还有更早的', () => {
    const turns = Array.from({ length: 20 }, (_, i) => fatTurn(`o${i}`, 40));
    const older = trimOlderForTransport({ epoch: 'e1', turns, hasOlder: false });
    expect(JSON.stringify(older.turns).length).toBeLessThanOrEqual(TRANSPORT_PAYLOAD_BUDGET);
    expect(older.hasOlder).toBe(true);
    // 接口语义:返回的这一段必须紧挨着手机手里那份的左边,所以丢的是更旧的那头。
    expect(older.turns.at(-1)!.id).toBe('o19');
  });
});

/**
 * owner 10-15「手机上看的话每张图传过去岂不是很 costly」:图不随记录下发。发给手机的那一份里每张图只留
 * `{ mimeType, chars }`(`imageRefs`),手机滚到它、那一轮展开了再按 (会话, 条目, 第几张) 去取。
 */
describe('工具交回来的图只带类型和字数', () => {
  const snapshotOf = (turns: TranscriptTurn[]): TimelineSnapshot =>
    ({ cursor: { epoch: 'e1', seq: 1 }, turns, settlements: [], hasOlder: false }) as unknown as TimelineSnapshot;
  const picture = (chars: number, mark: string) => ({ mimeType: 'image/jpeg', data: mark.repeat(chars) });
  /** app_check 交回的那四张(真记录:4 张共 119,120 字)。 */
  const fourShots = () => [31, 29, 30, 29].map((k, i) => picture(k * 1024, 'abcd'[i]!));
  const toolOf = (t: TranscriptTurn) => t.items[0] as Record<string, unknown>;

  it('快照里每张图换成 { mimeType, chars },图数据一个字都不带;图没丢,❌ 算进 trimmedChars', () => {
    const fitted = trimSnapshotForTransport(snapshotOf([turn('t1', [execTool('a', { outputText: 'ok', images: fourShots() })])]));
    const tool = toolOf(fitted.turns[0]!);
    expect(tool).not.toHaveProperty('images');
    expect(tool.imageRefs).toEqual([31, 29, 30, 29].map((k) => ({ mimeType: 'image/jpeg', chars: k * 1024 })));
    expect(tool).not.toHaveProperty('trimmedChars');
    expect(JSON.stringify(fitted)).not.toContain('aaaaaaaa');
  });

  it('首屏轮数不再被图挤掉:四轮各带四张,四轮都在、hasOlder 不抬(以前带图的一轮自己就占满一页)', () => {
    const turns = ['t1', 't2', 't3', 't4'].map((id) => turn(id, [execTool(`${id}-check`, { images: fourShots() })]));
    // 阳性前提:图要是跟着走,两轮就装不下一页。
    expect(JSON.stringify(turns.slice(-2)).length).toBeGreaterThan(TRANSPORT_PAYLOAD_BUDGET);
    const fitted = trimSnapshotForTransport(snapshotOf(turns));
    expect(fitted.turns.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(fitted.hasOlder).toBe(false);
    expect(fitted.turns.map((t) => (toolOf(t).imageRefs as unknown[]).length)).toEqual([4, 4, 4, 4]);
  });

  it('订阅推来的增量、往前翻的那一页、工具组里的子调用,都一样只带类型和字数', () => {
    const patch = { ...turn('t1', [execTool('a', { images: fourShots() })]), itemIds: ['a'] } as unknown as TurnPatch;
    const batch = trimBatchForTransport({ from: 0, cursor: { epoch: 'e1', seq: 2 }, turns: [patch], removedTurnIds: [], settlements: [] });
    expect(batch.turns[0]!.items[0]).not.toHaveProperty('images');
    expect((batch.turns[0]!.items[0] as Record<string, unknown>).imageRefs).toHaveLength(4);

    const older = trimOlderForTransport({ epoch: 'e1', turns: [turn('o1', [execTool('b', { images: fourShots() })])], hasOlder: false });
    expect(toolOf(older.turns[0]!).imageRefs).toHaveLength(4);

    const group = { ...execTool('g'), kind: 'tool-group', children: [execTool('child', { images: fourShots() })] } as unknown as ToolNode;
    const [trimmed] = trimTurnsForTransport([turn('t1', [group])]);
    const child = (toolOf(trimmed!).children as Record<string, unknown>[])[0]!;
    expect(child).not.toHaveProperty('images');
    expect(child.imageRefs).toHaveLength(4);
  });

  it('桌面读的那一份不动:换的是一份新的,原条目上的图一张不少', () => {
    const images = fourShots();
    const tool = execTool('a', { images });
    trimTurnsForTransport([turn('t1', [tool])]);
    expect((tool as unknown as { images: unknown[] }).images).toBe(images);
  });
});
