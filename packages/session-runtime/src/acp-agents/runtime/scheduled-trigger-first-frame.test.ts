/*
 * 2026-10-28 MBP 验收:定时任务到点(07:59:01 开轮)到模型第一段输出(07:59:07)之间,过程行只显示「执行中 · 0s…5s」。
 * 这条钉的是运行时这一侧:宿主注入投递走的那条入口(`tryInjectSessionMessage` → `injectEmdashPromptDetached` →
 * `promptDetached`,next-tool-call 家带 steerIfBusy)开轮时,发出去的第一帧 activeTurn 就带着 trigger,
 * ❌ 等模型出字。界面那一侧「还没输出的那一轮」怎么画,归渲染层。
 */
import { isOk } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SCHEDULED = '<gugu_delivery route="scheduled" from="咕咕系统" from_id="system:gugu" schedule="daily check">run it</gugu_delivery>';

describe('the injected delivery path publishes the trigger with the turn\'s first frame', () => {
  it('a scheduled delivery admitted through promptDetached: the first published active turn already carries trigger schedule, before any model output', async () => {
    const h = makeAcpHarness();
    h.agent.prompt.mockImplementation(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    expect(isOk(await rt.startSession(makeStartInput({ sessionId: 'conv-scheduled' })))).toBe(true);
    const live = rt.sessionLiveModels('conv-scheduled');
    if (!live) throw new Error('expected live models');
    const frames: unknown[] = [];
    const unsubscribe = live.states.activeTurn.subscribe(() => {
      const turn = live.states.activeTurn.snapshot().data;
      if (turn) frames.push(turn.trigger ?? null);
    });

    const started = rt.promptDetached('conv-scheduled', { text: SCHEDULED, origin: 'communication' }, { steerIfBusy: true });
    expect(isOk(started)).toBe(true);
    await h.agent.called('prompt');
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));

    expect(frames[0], 'the very first frame knows a schedule started it').toEqual({ kind: 'schedule' });
    expect(frames.every((trigger) => (trigger as { kind?: string } | null)?.kind === 'schedule')).toBe(true);
    unsubscribe();
  });
});
