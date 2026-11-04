/**
 * 流式片段不许重建它周围的工具结构(#1181)。
 *
 * 这一格测的不是「快不快」,而是**那条快路径的契约**:一个片段只改写它自己那一条顶层条目,
 * 别的条目(读组、子调用、它们的 children)必须原对象带过去。契约破了(比如哪天又回去
 * `normalizeToolStructure` 整份重建)这条用例会红 —— 而它红了之后,长回合的平方级成本也就回来了。
 *
 * 判据是对象身份,不是计时:计时用例在 CI 上受调度摆布,而身份是确定的。
 */
import { describe, expect, it } from 'vitest';
import { foldItem } from './item-fold';
import type { NormalizedEvent } from './normalized-event';
import type { ToolCallItem } from '../models/turns';

const TURN = 'conv:turn:0';

/** `foldItem` 收的是 `FoldEvent`(消息/思维的 messageId 已经由段合成器补齐),工具这条正好逐字相同。 */
const tool = (
  toolCallId: string,
  toolKind: string,
  parentToolCallId: string | null = null,
): Extract<NormalizedEvent, { kind: 'tool_call' }> => ({
  kind: 'tool_call',
  toolCallId,
  title: `${toolKind} ${toolCallId}`,
  toolKind,
  status: 'pending',
  parentToolCallId,
  locations: [],
});

describe('streamed chunk fast path', () => {
  it('keeps every other item by identity and rebuilds nothing (#1181)', () => {
    let items = foldItem([], { kind: 'message', role: 'assistant', messageId: 'a', text: '第一段' }, TURN, 1);
    // 两次连着的读取 → 一个读组;一次执行 + 它的子调用 → 一棵两层的小树。
    items = foldItem(items, tool('r1', 'read'), TURN, 2);
    items = foldItem(items, tool('r2', 'read'), TURN, 3);
    items = foldItem(items, tool('e1', 'execute'), TURN, 4);
    items = foldItem(items, tool('c1', 'search', 'e1'), TURN, 5);
    expect(items.some((item) => item.kind === 'tool-group')).toBe(true);

    const before = items;
    const next = foldItem(items, { kind: 'message', role: 'assistant', messageId: 'a', text: ' 续写' }, TURN, 6);

    expect(next).not.toBe(before);
    expect(next).toHaveLength(before.length);
    // 只有那条消息换了对象,其余按身份原样带过去:读组与组里的成员都还是原来那个对象。
    const rebuilt = next.filter((item, index) => item !== before[index]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ kind: 'message', text: '第一段 续写' });
    for (const item of next) {
      if (item === rebuilt[0]) continue;
      expect(before).toContain(item);
    }
  });

  it('a chunk that lands while a later thinking row is open settles it without rebuilding the tools (#1181)', () => {
    let items = foldItem([], { kind: 'message', role: 'assistant', messageId: 'a', text: '先答一句' }, TURN, 1);
    items = foldItem(items, tool('r1', 'read'), TURN, 2);
    // 答话中途又开了一段推理:它开着的时候,那条消息的下一个片段到了。
    items = foldItem(items, { kind: 'thinking', messageId: 'th2', text: '再想一下' }, TURN, 3);
    const before = items;
    const groupBefore = before.find((item) => item.kind === 'tool-group');
    expect(before.some((item) => item.kind === 'thinking' && item.status === 'thinking')).toBe(true);

    const next = foldItem(items, { kind: 'message', role: 'assistant', messageId: 'a', text: '，再答一句' }, TURN, 5);

    // 思维行落定(没变的老行为:内容型事件到达 = 代理已经离开推理阶段),工具按身份带过去(新契约)。
    expect(next.find((item) => item.kind === 'thinking')).toMatchObject({ status: 'done', durationMs: 2 });
    expect(next.find((item) => item.kind === 'tool-group')).toBe(groupBefore);
    expect(next.find((item) => item.kind === 'message')).toMatchObject({ text: '先答一句，再答一句' });
  });

  it('a chunk on a turn with nested children keeps the child objects (#1181)', () => {
    let items = foldItem([], { kind: 'message', role: 'assistant', messageId: 'a', text: 'x' }, TURN, 1);
    items = foldItem(items, tool('e1', 'execute'), TURN, 2);
    items = foldItem(items, tool('c1', 'search', 'e1'), TURN, 3);
    const executor = items.find((item) => (item as ToolCallItem).toolCallId === 'e1') as ToolCallItem;
    expect(executor.children).toHaveLength(1);
    const child = executor.children![0];

    const next = foldItem(items, { kind: 'message', role: 'assistant', messageId: 'a', text: 'y' }, TURN, 4);
    const nextExecutor = next.find((item) => (item as ToolCallItem).toolCallId === 'e1') as ToolCallItem;

    expect(nextExecutor).toBe(executor);
    expect(nextExecutor.children![0]).toBe(child);
  });

  it('still folds the chunk into the message it belongs to (#1181)', () => {
    let items = foldItem([], { kind: 'message', role: 'assistant', messageId: 'a', text: '甲' }, TURN, 1);
    items = foldItem(items, tool('r1', 'read'), TURN, 2);
    items = foldItem(items, { kind: 'message', role: 'assistant', messageId: 'a', text: '乙' }, TURN, 3);

    expect(items.find((item) => item.kind === 'message')).toMatchObject({ text: '甲乙' });
    // 另一条消息(不同 id)仍然按老路新建,并排在最后。
    const withSecond = foldItem(items, { kind: 'message', role: 'assistant', messageId: 'b', text: '丙' }, TURN, 4);
    expect(withSecond.filter((item) => item.kind === 'message')).toHaveLength(2);
    expect(withSecond.at(-1)).toMatchObject({ kind: 'message', text: '丙' });
  });
});
