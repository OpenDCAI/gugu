import { decodeSessionUpdate } from '@gugu/session-core/acp';
/**
 * #6582 —— 后台命令的终态改的是**起它的那一轮**,而那一轮之后已经又提交过别的轮。
 *
 * 真机(本机 Beta 0.2.50-beta.38.1,会话「变更统计」):第 3 轮起了一个后台 PowerShell 和一个 Monitor,
 * Monitor 的事件又各开了一轮(第 4–6 轮)。两个任务结束时第 7 轮正在进行,运行时在内存里把第 3 轮
 * 那两张卡落定了(第 7 轮里有两行「后台命令已完成」),但库里第 3 轮那一行还是提交时的样子 ——
 * `emitCommittedTurns` 只在**最后一轮**变了时发修订。重启之后(或从库里重开这条会话)面板画的是库里那份,
 * 那两张卡于是永远「在跑」。
 *
 * 这里按协议把同一条序列喂给真实的 runtime + cell(经 ACP client 的 `sessionUpdate`,与 stdio 进来的
 * 通知同一条路),断言起命令那一轮带着 `backgroundTaskDone` 推给了落盘方。它不是最后一轮,所以标 `backfill`
 * (说的是过去),不标 `revision` —— 「登录已失效」这类读现状的消费方靠这个区分。
 */
import { describe, expect, it, vi } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { isOk } from '@gugu/session-shared';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const SESSION = 'session-1';
const text = (t: string) =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } }) as SessionUpdate;
const completed = {
  sessionUpdate: 'async_task_state_update',
  asyncTaskId: 'bg-1',
  state: 'completed',
  summary: 'RUN completed/success',
} as unknown as SessionUpdate;

type Committed = { source: string; turn: TranscriptTurn };
type LaunchCard = { backgroundTaskId?: string; backgroundTaskDone?: true };

function launchCard(turn: TranscriptTurn): LaunchCard | undefined {
  return turn.items.find(
    (item) => 'toolCallId' in item && (item as { toolCallId?: string }).toolCallId === 'call_bg'
  ) as LaunchCard | undefined;
}

/** 第 0 轮起后台命令并落定,第 1 轮再说一句 —— 起命令那一轮从此不是最后一轮。 */
async function launchThenAnotherTurn(sessionId: string, agentInitiatedTurns?: 'cost-usage-ends-turn') {
  const committed: Committed[] = [];
  const h = makeAcpHarness({
    ...(agentInitiatedTurns ? { agentInitiatedTurns } : {}),
    onTurnCommitted: ({ source, turn }) => committed.push({ source, turn }),
  });
  const rt = new AcpRuntime(h.deps);
  expect(isOk(await rt.startSession(makeStartInput({ sessionId })))).toBe(true);
  const client = h.client();

  // 每次 prompt 挂住,由测试决定何时答复 —— 事件要落在 prompt 进行中。
  const answers: Array<(value: { stopReason: string }) => void> = [];
  h.agent.prompt = vi.fn().mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
  const turn = async (prompt: string, during: () => unknown) => {
    const index = answers.length;
    const done = rt.sendPrompt(sessionId, { text: prompt });
    await h.agent.called('prompt', index + 1);
    expect(answers).toHaveLength(index + 1);
    await during();
    answers[index]!({ stopReason: 'end_turn' });
    await done;
  };

  await turn('poll CI in the background', async () => {
    await client.sessionEvent({
      sessionId: SESSION,
      event: decodeSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call_bg', title: 'poll CI', kind: 'execute', status: 'completed' } as SessionUpdate),
    });
    await client.sessionEvent({
      sessionId: SESSION,
      event: decodeSessionUpdate({ sessionUpdate: 'async_task_progress', asyncTaskId: 'bg-1', toolCallId: 'call_bg' } as unknown as SessionUpdate),
    });
  });
  await turn('anything else?', () => client.sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(text('still waiting on CI')) }));

  expect(committed.map((entry) => entry.source)).toEqual(['live', 'live']);
  const launchTurn = committed[0]!.turn;
  expect(launchCard(launchTurn)?.backgroundTaskId, '前提:卡挂上了后台任务 id').toBe('bg-1');
  expect(launchCard(launchTurn)?.backgroundTaskDone).toBeUndefined();
  return { rt, client, committed, turn, launchTurnId: launchTurn.id };
}

describe('#6582 后台命令终态回填到更早的那一轮', () => {
  it('空闲时到达(claude 形状):起命令那一轮带着落定标记补推出去(backfill),只推一次', async () => {
    const { rt, client, committed, launchTurnId } = await launchThenAnotherTurn(
      'conv-idle',
      'cost-usage-ends-turn',
    );

    expect(rt.getSessionState('conv-idle').backgroundCommandTaskIds, '在跑时运行时报出它的任务 id').toEqual(['bg-1']);
    await client.sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(completed) });

    const pushedAgain = committed.slice(2);
    expect(pushedAgain.map((entry) => [entry.source, entry.turn.id]), '补推的是起命令那一轮,不是最后一轮').toEqual([
      ['backfill', launchTurnId],
    ]);
    expect(launchCard(pushedAgain[0]!.turn)?.backgroundTaskDone).toBe(true);
    expect(rt.getSessionState('conv-idle').backgroundCommandCount).toBe(0);
    expect(rt.getSessionState('conv-idle').backgroundCommandTaskIds).toEqual([]);

    // 之后的流式事件不改已提交的轮 ⇒ 不再补推(❌ 每个事件都把库里的轮重写一遍)。
    await client.sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(text('CI is green')) });
    expect(committed).toHaveLength(3);
  });

  it('另一轮进行中到达(真机那一格):先补推起命令那一轮,进行中那一轮收口时照常 live', async () => {
    const { client, committed, turn, launchTurnId } = await launchThenAnotherTurn('conv-mid-turn');

    await turn('check the release', async () => {
      await client.sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(text('checking')) });
      await client.sessionEvent({ sessionId: SESSION, event: decodeSessionUpdate(completed) });
      expect(committed.map((entry) => entry.source), '当场补推,不等这一轮收口').toEqual(['live', 'live', 'backfill']);
    });

    expect(committed.map((entry) => entry.source)).toEqual(['live', 'live', 'backfill', 'live']);
    expect(committed[2]!.turn.id).toBe(launchTurnId);
    expect(launchCard(committed[2]!.turn)?.backgroundTaskDone).toBe(true);
    expect(committed[3]!.turn.items.map((item) => item.kind)).toContain('background-command-done-tool-call');
  });
});
