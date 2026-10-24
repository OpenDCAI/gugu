/**
 * 停掉一条正在跑一轮的会话(session_stop / 归档 / 删除 / App stopAgent 都走 `stopSession`)。
 *
 * mac1 真机读数(2026-10-08,dev afe7f9136):claude 的适配器在 `session/close` 里自己把在飞的 prompt 答成
 * `cancelled`,codex 不答 —— 宿主拆掉连接后 prompt 才以 SDK 的 `ACP connection closed` 被拒,
 * 那一轮落成 errored,而且这时会话已经移除,那次落定又给它凭空写回一条摘要,状态读成 error。
 * 这里按协议把 codex 那条序列喂给真实的 runtime + cell。
 */
import { isOk } from '@gugu/session-shared';
import type { TranscriptTurnOutcome } from '@gugu/session-core/acp';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

async function turnInFlight(sessionId: string) {
  const outcomes: Array<TranscriptTurnOutcome | undefined> = [];
  const h = makeAcpHarness({ onTurnCommitted: ({ turn }) => outcomes.push(turn.outcome) });
  const rt = new AcpRuntime(h.deps);
  expect(isOk(await rt.startSession(makeStartInput({ sessionId })))).toBe(true);
  let rejectPrompt!: (error: unknown) => void;
  h.agent.prompt = vi.fn(() => new Promise((_, reject) => { rejectPrompt = reject; }));
  const sent = rt.promptDetached(sessionId, { text: 'sleep 300' });
  if (!sent.success) throw new Error('Missing session');
  await sent.data.admission;
  const turn = sent.data.completion;
  await h.agent.called('prompt');
  const summaries = () => rt.sessionsListLiveModel().states.list.snapshot().data;
  return { h, rt, turn, outcomes, summaries, rejectPrompt: (error: unknown) => rejectPrompt(error) };
}

describe('stopSession with a turn in flight', () => {
  it('codex 形:close 不答 prompt、拆连接后才被拒 —— 那一轮是被停下,会话不再出现在摘要里', async () => {
    const { rt, turn, outcomes, summaries, rejectPrompt } = await turnInFlight('conv-stop-mid-turn');
    expect(summaries()['conv-stop-mid-turn']).toBeDefined();

    expect(isOk(await rt.stopSession('conv-stop-mid-turn'))).toBe(true);
    rejectPrompt(new Error('ACP connection closed'));
    await turn;

    expect(outcomes.at(-1)?.kind).toBe('cancelled');
    expect(summaries()['conv-stop-mid-turn'], '移除之后的落定 ❌ 写回摘要').toBeUndefined();
  });

  it('阴控 —— 没要求关,线断了照旧是失败', async () => {
    const { turn, outcomes, rejectPrompt } = await turnInFlight('conv-wire-cut');

    rejectPrompt(new Error('ACP connection closed'));
    await turn;

    expect(outcomes.at(-1)?.kind).toBe('error');
  });

  it('关的同时 provider 自己回了错:那是它说的话,照旧是失败', async () => {
    const { h, rt, turn, outcomes, rejectPrompt } = await turnInFlight('conv-provider-error');
    h.agent.closeSession.mockImplementationOnce(async () => {
      rejectPrompt(Object.assign(new Error('upstream 429'), { name: 'RequestError', code: -32603 }));
      await vi.waitFor(() => expect(outcomes.at(-1)?.kind).toBe('error'));
      return {};
    });
    expect(isOk(await rt.stopSession('conv-provider-error'))).toBe(true);
    await turn;

    expect(outcomes.at(-1)?.kind).toBe('error');
  });
});
