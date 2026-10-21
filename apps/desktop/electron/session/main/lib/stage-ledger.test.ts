// #4320 —— 分段账本的行为表。
//
// 判据先证明自己能判假(实测):把 settle 的门槛改成 `>=` 预算,`never warns exactly at the budget`
// 当场红、其余三条保持绿。
import { describe, expect, it, vi } from 'vitest';

const infoMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/logger', () => ({
  log: { info: infoMock, warn: warnMock, debug: vi.fn(), error: vi.fn() },
}));

import { createStageLedger } from './stage-ledger';

function clock(times: number[]): () => number {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)]!;
}

describe('#4320 stage ledger (session-page half)', () => {
  it('marks every stage with its elapsed offset', () => {
    infoMock.mockClear();
    const ledger = createStageLedger({
      scope: 'taskpage/test',
      what: 'probe',
      fields: { sessionId: 'c1' },
      budgetMs: 1_000,
      now: clock([0, 40, 90]),
    });
    ledger.mark('a');
    ledger.mark('b', { extra: 1 });
    expect(infoMock.mock.calls.map(([, fields]) => fields)).toEqual([
      { scope: 'taskpage/test', sessionId: 'c1', stage: 'a', elapsedMs: 40 },
      { scope: 'taskpage/test', sessionId: 'c1', stage: 'b', elapsedMs: 90, extra: 1 },
    ]);
  });

  it('stays silent when the chain finishes inside its budget', () => {
    warnMock.mockClear();
    const ledger = createStageLedger({
      scope: 'taskpage/test',
      what: 'probe',
      fields: {},
      budgetMs: 1_000,
      now: clock([0, 10, 500]),
    });
    ledger.mark('a');
    ledger.settle();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('never warns exactly at the budget — the boundary belongs to the quiet side', () => {
    warnMock.mockClear();
    const ledger = createStageLedger({
      scope: 'taskpage/test',
      what: 'probe',
      fields: {},
      budgetMs: 1_000,
      now: clock([0, 1_000]),
    });
    ledger.settle();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('warns once over budget with the per-stage breakdown and the slowest stage', () => {
    warnMock.mockClear();
    const ledger = createStageLedger({
      scope: 'taskpage/test',
      what: 'probe',
      fields: { sessionId: 'c1' },
      budgetMs: 1_000,
      now: clock([0, 100, 1_800, 2_000, 2_000]),
    });
    ledger.mark('fast');
    ledger.mark('slow');
    ledger.settle({ outcome: 'done' });
    ledger.settle({ outcome: 'again' });
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]![1]).toEqual({
      scope: 'taskpage/test',
      sessionId: 'c1',
      totalMs: 2_000,
      budgetMs: 1_000,
      slowestStage: 'slow',
      slowestMs: 1_700,
      breakdown: [
        { stage: 'fast', tookMs: 100 },
        { stage: 'slow', tookMs: 1_700 },
        { stage: 'settle', tookMs: 200 },
      ],
      outcome: 'done',
    });
  });
});
