/**
 * #5117 —— 子智能体**自己会话**上的事件要路由回主会话,并且不许冒充主会话。
 *
 * 谈成 `clientCapabilities.subagents` 后,0.75.1 把子智能体的输出改写成 `sessionId =
 * subagentSessionId` 发过来(context7 `/agentclientprotocol/claude-agent-acp`:「The agent
 * routes child output by rewriting the notification's sessionId to the child's sessionId」)。
 * 2026-09-06 真机:那条会话号路由表不认识,子智能体回传的正文整条丢弃(日志
 * `SessionManager: sessionUpdate for unknown sessionId a0fc0cd9f50848202`)。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { DRAFT_UPDATE_META_KEY } from '@gugu/session-core/acp';
import { isOk } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const ROOT = 'session-1';
const KID = 'a0fc0cd9f50848202';

function spawnedEnvelope(): SessionUpdate {
  // 进门信封(见 acp-stdio.ts `rewriteDraftSessionUpdates`):草案 update 裹在 tool_call_update 里。
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: KID,
    _meta: {
      [DRAFT_UPDATE_META_KEY]: {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: KID,
        name: '回传口令',
        task: '把口令原样回给我',
        capabilities: {},
      },
    },
  } as unknown as SessionUpdate;
}

function chunk(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as SessionUpdate;
}

async function openTurn(sessionId: string) {
  const h = makeAcpHarness();
  const rt = new AcpRuntime(h.deps);
  const started = await rt.startSession(makeStartInput({ sessionId }));
  expect(isOk(started)).toBe(true);
  let resolvePrompt: (value: { stopReason: 'end_turn' }) => void = () => {};
  h.agent.prompt = vi.fn(
    () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolvePrompt = resolve; })
  );
  const prompt = rt.sendPrompt(sessionId, { text: '派一个' });
  const live = rt.sessionLiveModels(sessionId);
  if (!live) throw new Error('expected live models');
  return { h, rt, client: h.client(), live, finish: async () => { resolvePrompt({ stopReason: 'end_turn' }); await prompt; } };
}

describe('#5117 子会话路由', () => {
  it('an advertised native child cancellation targets that child, never the parent', async () => {
    const { rt, client, h, finish } = await openTurn('native-codex-stop');
    const update = spawnedEnvelope();
    const draft = update._meta![DRAFT_UPDATE_META_KEY] as { capabilities: { cancel?: boolean } };
    draft.capabilities.cancel = true;
    await client.sessionUpdate({ sessionId: ROOT, update });
    expect((await rt.stopBackgroundTask('native-codex-stop', KID)).success).toBe(true);
    expect(h.agent.cancel).toHaveBeenCalledExactlyOnceWith({ sessionId: KID });
    await finish();
  });
  it('派生之后,子会话号上的正文到得了:进登记册 `output`,主会话的会话号不变', async () => {
    const { h, rt, client, live, finish } = await openTurn('conv-kid');

    await client.sessionUpdate({ sessionId: ROOT, update: spawnedEnvelope() });
    await client.sessionUpdate({ sessionId: KID, update: chunk('ZIWEIXINIU-7788') });

    // 子会话的正文跟着显示节拍发出(publishOnTick):等这一拍过完。
    await vi.waitFor(() => {
      const agents = live.states.agents.snapshot().data as Array<{ subagentSessionId?: string; output?: string }>;
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ subagentSessionId: KID, output: 'ZIWEIXINIU-7788' });
    });

    // 子会话的事件**不许**把 cell 的会话号改成子会话号:之后的 cancel 必须仍打到主会话。
    await rt.cancelTurn('conv-kid');
    expect(h.agent.cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: ROOT }));
    expect(h.agent.cancel).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: KID }));
    await finish();
  });

  it('阴控:没派生过的会话号照旧丢弃 —— ❌ 不凭空认亲', async () => {
    const { client, live, finish } = await openTurn('conv-stranger');

    await client.sessionUpdate({ sessionId: 'nobody', update: chunk('我是谁') });

    expect(live.states.agents.snapshot().data).toEqual([]);
    await finish();
  });

  it('单独停一个子智能体如实报「做不到」,❌ 不报成功', async () => {
    const { rt, client, h, finish } = await openTurn('conv-stop');
    await client.sessionUpdate({ sessionId: ROOT, update: spawnedEnvelope() });

    const result = await rt.stopBackgroundTask('conv-stop', KID);

    expect(result.success).toBe(false);
    // 既没对子会话号发 cancel(0.75.1 那是空操作),也没落回后台任务那支的 extMethod。
    expect(h.agent.cancel).not.toHaveBeenCalled();
    await finish();
  });
});
