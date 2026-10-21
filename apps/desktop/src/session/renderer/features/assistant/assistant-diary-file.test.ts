import { describe, expect, it } from 'vitest';
import { diaryBatches, diaryMonths, diaryPreview, type TodayBatch, type TodayFile } from './assistant-today-file';

// #7199 「<名字>」那一格的日记:today.json 里 kind = diary 的那几批(按月分组、卡片上一段预览)。

const batch = (id: string, kind: TodayBatch['kind'], localDate: string, markdown = ''): TodayBatch => ({
  id,
  kind,
  localDate,
  pushedAt: null,
  messageId: null,
  cards: markdown ? [{ id: `${id}-c`, title: '日记', markdown }] : [],
});

describe('日记', () => {
  it('只要 diary 那几批,新的在上;早晚简报不进来', () => {
    const file: TodayFile = {
      version: 1,
      widgets: [],
      day: { state: 'none' },
      ideas: { state: 'none' },
      batches: [batch('m', 'morning', '2026-10-15'), batch('d1', 'diary', '2026-10-13'), batch('e', 'evening', '2026-10-15'), batch('d2', 'diary', '2026-10-14')],
    };
    expect(diaryBatches(file).map((b) => b.id)).toEqual(['d2', 'd1']);
  });

  it('按月分组,组内保持先后', () => {
    const months = diaryMonths([batch('a', 'diary', '2026-10-02'), batch('b', 'diary', '2026-10-01'), batch('c', 'diary', '2026-09-30')]);
    expect(months.map((m) => [m.key, m.year, m.month, m.batches.map((b) => b.id)])).toEqual([
      ['2026-10', 2026, 10, ['a', 'b']],
      ['2026-09', 2026, 9, ['c']],
    ]);
  });

  it('预览去掉 markdown 记号只留字;没有正文 = 空', () => {
    expect(diaryPreview(batch('x', 'diary', '2026-10-15', '# 今天\n- 约到 **刘威** 打球\n> 看了 [周报](https://x.y) `draft`'))).toBe('今天 约到 刘威 打球 看了 周报 draft');
    expect(diaryPreview(batch('y', 'diary', '2026-10-15'))).toBe('');
  });
});
