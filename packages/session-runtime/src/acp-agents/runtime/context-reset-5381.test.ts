/**
 * #5381 ④ —— `session/load` 失败之后的降级不许是静默的。
 *
 * 产品的选择是「会话照常打开」而不是把它变成一个打不开的东西,这条不变。但会话页现在
 * **自己存着历史**:屏幕上照旧满屏对话,而 agent 那边一个字都没有。用户看着历史,
 * 理所当然以为它读过 —— 它没有。合同原话:截断与失败都要留下可诊断的痕迹。
 *
 * ⚠️ 阴控同样要紧:用户**主动新建**的会话不该出现这条界(它没有「上面的内容」),
 * load 成功的重开也不该出现。
 */
import { describe, expect, it, vi } from 'vitest';
import { isOk } from '@gugu/session-shared';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { AcpTranscriptParser } from '@gugu/session-core/acp';
import type { TranscriptContextReset, TranscriptItem, TranscriptTurn } from '@gugu/session-core/acp';

function allItems(p: AcpTranscriptParser): TranscriptItem[] {
  const turns: readonly TranscriptTurn[] = [...p.history, ...(p.activeTurn ? [p.activeTurn] : [])];
  return turns.flatMap((turn) => turn.items as TranscriptItem[]);
}

function resets(p: AcpTranscriptParser): TranscriptContextReset[] {
  return allItems(p).filter((it): it is TranscriptContextReset => it.kind === 'context-reset');
}

describe('#5381 引擎重开会话的界线', () => {
  it('画出来,并且**带着原因** —— 只画一条线的话,事后分不开是哪一种失败', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    p.pushEvent(
      { kind: 'context_reset', reason: 'Session not found: sess_abc' } as never,
      1_000
    );
    const rows = resets(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe('Session not found: sess_abc');
    expect(rows[0]!.at).toBe(1_000);
  });

  it('一次重开只有一条线 —— 重复推送落回同一行', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    p.pushEvent({ kind: 'context_reset', reason: 'boom' } as never, 1);
    p.pushEvent({ kind: 'context_reset', reason: 'boom' } as never, 2);
    expect(resets(p)).toHaveLength(1);
  });

  /** 阴控:没发生过降级的会话上不许出现这条界 —— 那会让用户白白重说一遍。 */
  it('阴控 —— 普通会话上没有这条界', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '你好' } as never, 1);
    p.pushEvent({ kind: 'message', role: 'assistant', messageId: 'a1', text: '在' } as never, 2);
    expect(resets(p)).toHaveLength(0);
  });
});

/**
 * 接线的那一端:`session/load` 真的失败、真的退回 `session/new` 时,那条界要出现在
 * 新会话的转录开头。上面那组用例只证明「推了这个事件会成行」,不证明**有人推**。
 */
describe('#5381 重放失败退回 session/new 时,界线真的被画出来', () => {
  it('load 失败 → 新会话开头有一条界,带着失败原因', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => {
      throw new Error('internal error: rollout store unavailable');
    });
    const rt = new AcpRuntime(h.deps);
    await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-load-failed' }),
      providerSessionId: 'session-old',
    });

    // 降级本身照旧:会话照常打开,只是换了一条 provider 会话。
    expect(h.agent.newSession).toHaveBeenCalled();

    // 界线先落在活动轮里(它是 agent 侧自发的一条内容,没有 prompt 在飞)。
    // 用户下一次说话会把那一轮收口 —— 收口之后它才进已提交层,也才会被主进程落库。
    // ⚠️ 这条断言特意跑在 sendPrompt **之后**:它同时钉住了「画得出来」与
    // 「留得下来」。只在活动轮里断言的话,重启一次这条界就没了,而 agent 仍然缺着上下文。
    await rt.sendPrompt('conv-load-failed', { text: '接着说' });

    const history = rt.getHistory('conv-load-failed');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    const items = history.data.turns.flatMap(
      (turn) => turn.items as Array<{ kind: string; reason?: string }>
    );
    const reset = items.find((it) => it.kind === 'context-reset');
    expect(reset).toBeDefined();
    expect(reset!.reason).toContain('rollout store unavailable');
  });

  /** 阴控:load 成功的重开不许出现这条界。 */
  it('阴控 —— load 成功的重开没有这条界', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => ({}));
    const rt = new AcpRuntime(h.deps);
    await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-load-ok' }),
      providerSessionId: 'session-old',
    });

    const history = rt.getHistory('conv-load-ok');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    const items = history.data.turns.flatMap((turn) => turn.items as Array<{ kind: string }>);
    expect(items.some((it) => it.kind === 'context-reset')).toBe(false);
  });
})
