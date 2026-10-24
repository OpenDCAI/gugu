/**
 * #5117 —— 谈成 `clientCapabilities.subagents` + AIR `asyncTasks` 之后的原生形态。
 *
 * 这组用例钉的是**根因**:不握手时协议把子智能体的一切留在根会话上且不带血缘
 * (0.75.1 README:「child interactions stay on the root session」),客户端想过滤都没依据;
 * 握手之后归属由协议给,`toolCallId` 缺席的含义是「还不知道」而不是「没有父调用」。
 *
 * ⚠️ 这里最要命的一条是**阴控**:归属未知的后台任务**不许**变成一条顶层行。
 * 那条凭空多出来的行就是 owner 说的「子智能体的事泄露到主 agent 这儿」。
 */
import { describe, expect, it } from 'vitest';
import { decodeSessionUpdate, decodeV2SessionUpdate } from '../transport/decode';
import { AcpTranscriptParser } from './parser';
import type { TranscriptItem, TranscriptTurn } from '../models/turns';

type BackgroundFields = { backgroundTaskId?: string; backgroundTaskDone?: true };

function allItems(p: AcpTranscriptParser): Array<TranscriptItem & BackgroundFields> {
  const turns: readonly TranscriptTurn[] = [...p.history, ...(p.activeTurn ? [p.activeTurn] : [])];
  const out: Array<TranscriptItem & BackgroundFields> = [];
  const walk = (items: readonly unknown[]): void => {
    for (const raw of items) {
      const item = raw as TranscriptItem & BackgroundFields & { children?: unknown[] };
      out.push(item);
      if (Array.isArray(item.children)) walk(item.children);
    }
  };
  for (const turn of turns) walk(turn.items);
  return out;
}

/** 一次主 agent 的后台命令派发:那次调用在派发时就完成了。 */
function launchBackgroundCommand(p: AcpTranscriptParser): void {
  p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '后台跑一条' } as never, 1);
  p.pushEvent(
    {
      kind: 'tool_call',
      toolCallId: 'call_bash',
      title: 'sleep 3000',
      toolKind: 'execute',
      status: 'completed',
      parentToolCallId: null,
          locations: [],
    } as never,
    2
  );
}

describe('#5117 后台任务的原生 lane', () => {
  it('阴控 —— 归属未知的后台任务不许长出一条顶层行(这就是那条泄露)', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    const before = allItems(p).length;

    // 子智能体名下起的后台命令:根会话不认识它的 toolCallId,协议因此不带这一格。
    p.pushEvent(
      {
        kind: 'async_task',
        asyncTaskId: 'task_orphan',
        name: 'Bash',
        taskType: 'Bash',
        description: 'sleep 999',
        showInTranscript: true,
        canStop: false,
      } as never,
      3
    );

    expect(allItems(p).length).toBe(before);
    expect(allItems(p).some((i) => i.backgroundTaskId === 'task_orphan')).toBe(false);
  });

  it('归属已知:后台任务 id 落到派它出去的那张卡上,❌ 不另起一行', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    const before = allItems(p).length;

    p.pushEvent(
      {
        kind: 'async_task',
        asyncTaskId: 'task_1',
        name: 'Bash',
        taskType: 'Bash',
        description: 'sleep 3000',
        showInTranscript: true,
        canStop: true,
        toolCallId: 'call_bash',
      } as never,
      3
    );

    expect(allItems(p).length).toBe(before);
    const card = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(card?.backgroundTaskId).toBe('task_1');
    expect(card?.backgroundTaskDone).toBeUndefined();
  });

  it('终态回到那张卡:落定,并且不再算在跑', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    p.pushEvent(
      {
        kind: 'async_task',
        asyncTaskId: 'task_1',
        name: 'Bash',
        taskType: 'Bash',
        description: 'sleep 3000',
        showInTranscript: true,
        canStop: true,
        toolCallId: 'call_bash',
      } as never,
      3
    );
    p.pushEvent(
      {
        kind: 'async_task_state',
        asyncTaskId: 'task_1',
        state: 'completed',
        summary: '跑完了',
        toolCallId: 'call_bash',
      } as never,
      4
    );

    const card = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(card?.backgroundTaskDone).toBe(true);
  });

  it('归属在 progress 上才到(真机 2026-09-07 形状):spawned 不带 toolCallId 不立行,progress 带了就认领到那张卡', () => {
    // raw-e735816b.json 第 38/39 条:async_task_spawned 无 toolCallId,1ms 后 async_task_progress 带
    // `toolCallId=call_BNdi…`。修前只看 spawned ⇒ 卡永远挂不上任务 id ⇒ 摘要栏没有后台命令。
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    const before = allItems(p).length;
    p.pushEvent(
      {
        kind: 'async_task',
        asyncTaskId: 'bi01f1i83',
        name: '运行四十秒后台终端任务',
        taskType: 'Bash',
        description: 'sleep 40',
        showInTranscript: true,
        canStop: true,
      } as never,
      3
    );
    expect(allItems(p).length).toBe(before);

    p.pushEvent(
      { kind: 'async_task_progress', asyncTaskId: 'bi01f1i83', toolCallId: 'call_bash' } as never,
      4
    );
    expect(allItems(p).length).toBe(before);
    const card = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(card?.backgroundTaskId).toBe('bi01f1i83');
    expect(card?.backgroundTaskDone).toBeUndefined();

    // 之后不带 toolCallId 的终态也能按「哪张卡挂着这个任务 id」找回来。
    p.pushEvent({ kind: 'async_task_state', asyncTaskId: 'bi01f1i83', state: 'completed' } as never, 5);
    const settled = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(settled?.backgroundTaskDone).toBe(true);
    // 多出的只有「后台命令已完成」那一行。
    expect(allItems(p).length).toBe(before + 1);
    expect(allItems(p).filter((i) => i.kind === 'background-command-done-tool-call')).toHaveLength(1);
  });

  it('派它那一轮已经落定、完成在下一轮才到:就地落定那张卡,❌ 不在新一轮长出一行「工具」', () => {
    // owner 2026-09-07 真机:`sleep 60` 跑完了,摘要栏那张卡还挂着,新一轮里多了一行光秃秃的「工具」。
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    p.pushEvent(
      { kind: 'async_task_progress', asyncTaskId: 'task_1', toolCallId: 'call_bash' } as never,
      3
    );
    p.settleTurn({ kind: 'done', reason: 'end_turn' } as never);
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u2', text: '继续' } as never, 4);
    const activeBefore = p.activeTurn?.items.length ?? 0;

    p.pushEvent({ kind: 'async_task_state', asyncTaskId: 'task_1', state: 'completed' } as never, 5);

    const card = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(card?.backgroundTaskDone).toBe(true);
    expect(p.history[0].items.some((i) => (i as { toolCallId?: string }).toolCallId === 'call_bash')).toBe(true);
    // 新一轮里只多「后台命令已完成」那一行,❌ 没有那行光秃秃的「工具」。
    const added = (p.activeTurn?.items ?? []).slice(activeBefore);
    expect(added.map((i) => i.kind)).toEqual(['background-command-done-tool-call']);
  });

  it('老形态的 task-notification 在下一轮到,同样就地落定,❌ 不新建行', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    p.pushEvent(
      { kind: 'async_task_progress', asyncTaskId: 'task_1', toolCallId: 'call_bash' } as never,
      3
    );
    p.settleTurn({ kind: 'done', reason: 'end_turn' } as never);
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u2', text: '继续' } as never, 4);
    const activeBefore = p.activeTurn?.items.length ?? 0;

    p.pushEvent(
      { kind: 'subagent_done', toolCallId: 'call_bash', agentId: 'task_1', status: 'completed', summary: '退出码 0' },
      5
    );

    const card = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(card?.backgroundTaskDone).toBe(true);
    const added = (p.activeTurn?.items ?? []).slice(activeBefore);
    expect(added.map((i) => i.kind)).toEqual(['background-command-done-tool-call']);
  });

  it('跑完了自己一行(与子智能体同一形态);stopped 暂定后被 completed 纠正,仍只有一行、结局是完成', () => {
    // owner 2026-09-07:「命令完成没有提示啊,agent 运行完都有提示,他没有」。
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    p.pushEvent(
      { kind: 'async_task_progress', asyncTaskId: 'task_1', toolCallId: 'call_bash' } as never,
      3
    );
    p.settleTurn({ kind: 'done', reason: 'end_turn' } as never);

    // 真机形状:先 stopped(清单尽力而为),2ms 后 completed 纠正。
    p.pushEvent({ kind: 'async_task_state', asyncTaskId: 'task_1', state: 'stopped' } as never, 9);
    p.pushEvent({ kind: 'async_task_state', asyncTaskId: 'task_1', state: 'completed' } as never, 10);

    const doneRows = allItems(p).filter((i) => i.kind === 'background-command-done-tool-call') as Array<
      TranscriptItem & { name?: string; outcome?: string; launchToolCallId?: string }
    >;
    expect(doneRows).toHaveLength(1);
    expect(doneRows[0]).toMatchObject({ name: 'sleep 3000', outcome: 'completed', launchToolCallId: 'call_bash' });
    // 那一行不许挂后台任务 id —— 否则名册会把它当第二条在跑的命令。
    expect((doneRows[0] as BackgroundFields).backgroundTaskId).toBeUndefined();
  });

  it('阴控:子智能体的终态不长「后台命令跑完了」那一行(它有自己的 subagent-done)', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派一个' } as never, 1);
    p.pushEvent(
      {
        kind: 'subagent',
        toolCallId: 'sess_kid',
        subagentSessionId: 'sess_kid',
        title: '调研',
        status: 'in_progress',
        parentToolCallId: null,
      } as never,
      2
    );
    p.pushEvent(
      { kind: 'subagent_done', toolCallId: 'sess_kid', agentId: 'sess_kid', status: 'completed' } as never,
      3
    );
    expect(allItems(p).some((i) => i.kind === 'background-command-done-tool-call')).toBe(false);
    expect(allItems(p).some((i) => i.kind === 'subagent-done-tool-call')).toBe(true);
  });

  it('阴控:progress 也不带 toolCallId、卡上也没挂过 ⇒ 仍然不立行', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    const before = allItems(p).length;
    p.pushEvent({ kind: 'async_task_progress', asyncTaskId: 'nobody', summary: '半路' } as never, 3);
    expect(allItems(p).length).toBe(before);
    expect(allItems(p).some((i) => i.backgroundTaskId === 'nobody')).toBe(false);
  });

  it('`paused` 不是结束 —— ❌ 别把它折进终态', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    launchBackgroundCommand(p);
    p.pushEvent(
      {
        kind: 'async_task',
        asyncTaskId: 'task_1',
        name: 'Bash',
        taskType: 'Bash',
        description: 'sleep 3000',
        showInTranscript: true,
        canStop: true,
        toolCallId: 'call_bash',
      } as never,
      3
    );
    p.pushEvent(
      { kind: 'async_task_state', asyncTaskId: 'task_1', state: 'paused', toolCallId: 'call_bash' } as never,
      4
    );

    const card = allItems(p).find(
      (i) => 'toolCallId' in i && (i as { toolCallId?: string }).toolCallId === 'call_bash'
    );
    expect(card?.backgroundTaskDone).toBeUndefined();
  });
});

describe('#5117 子智能体会话的解码', () => {
  it('派生:带会话号与「能不能取消」,取消能力由 agent 给定', () => {
    const event = decodeSessionUpdate({
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'sess_kid',
      name: '调研澳门交通',
      task: '查 2026 通车段',
      capabilities: { cancel: true },
    } as never);

    expect(event.kind).toBe('subagent');
    if (event.kind !== 'subagent') throw new Error('unreachable');
    expect(event.subagentSessionId).toBe('sess_kid');
    expect(event.canCancel).toBe(true);
    expect(event.title).toBe('调研澳门交通');
  });

  it('阴控:agent 没说能取消就是不能取消 —— ❌ 不默认成 true', () => {
    const event = decodeSessionUpdate({
      sessionUpdate: 'subagent_spawned',
      subagentSessionId: 'sess_kid',
      name: '调研',
      task: 't',
      capabilities: {},
    } as never);

    if (event.kind !== 'subagent') throw new Error('unreachable');
    expect(event.canCancel).toBe(false);
  });

  it('失联(disconnected)是自己一态,❌ 不折进 failed', () => {
    const event = decodeSessionUpdate({
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'sess_kid',
      state: 'disconnected',
    } as never);

    if (event.kind !== 'subagent_done') throw new Error('unreachable');
    expect(event.status).toBe('disconnected');
    expect(event.status).not.toBe('failed');
  });

  it('cancelled 归到我们已有的「被叫停」', () => {
    const event = decodeSessionUpdate({
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'sess_kid',
      state: 'cancelled',
    } as never);

    if (event.kind !== 'subagent_done') throw new Error('unreachable');
    expect(event.status).toBe('stopped');
  });

  it('阳控:没谈成能力时这些 update 根本不会来,普通事件照旧解码', () => {
    // 少了这条,上面几条可以靠「decode 永远返回 subagent」这种废掉整个函数的实现拿绿灯。
    const event = decodeSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '你好' },
    } as never);
    expect(event.kind).toBe('message');
  });
});

describe('子智能体的 RFD 形态与 v2 的扩展更新名', () => {
  const decode = (update: Record<string, unknown>) => decodeSessionUpdate(update as never);

  it('宣布:带名字与取消能力的 `subagent_update` 立起一个子会话', () => {
    expect(decode({
      sessionUpdate: 'subagent_update',
      sessionId: 'agent-1',
      title: 'general-purpose',
      description: 'Review the diff',
      capabilities: { cancel: {} },
      state: { state: 'running' },
    })).toEqual({
      kind: 'subagent',
      toolCallId: 'agent-1',
      subagentSessionId: 'agent-1',
      title: 'general-purpose',
      inputSummary: 'Review the diff',
      status: 'in_progress',
      parentToolCallId: null,
      canCancel: true,
    });
  });

  it('只带状态的报它在跑或停下;cancelled 是被叫停,error 是跑砸', () => {
    expect(decode({ sessionUpdate: 'subagent_update', sessionId: 'a', state: { state: 'running' } }))
      .toMatchObject({ kind: 'subagent_update', subagentSessionId: 'a', status: 'in_progress' });
    expect(decode({ sessionUpdate: 'subagent_update', sessionId: 'a', state: { state: 'idle', stopReason: 'end_turn' } }))
      .toMatchObject({ kind: 'subagent_done', subagentSessionId: 'a', status: 'completed' });
    expect(decode({ sessionUpdate: 'subagent_update', sessionId: 'a', state: { state: 'idle', stopReason: 'cancelled' } }))
      .toMatchObject({ kind: 'subagent_done', status: 'stopped' });
    expect(decode({ sessionUpdate: 'subagent_update', sessionId: 'a', state: { state: 'idle', stopReason: 'error' } }))
      .toMatchObject({ kind: 'subagent_done', status: 'failed' });
  });

  it('v2 的 `_async_task_*` 与 v1 的 `async_task_*` 解成同一件事', () => {
    const spawned = { asyncTaskId: 'bash_1', name: 'sleep', taskType: 'local_bash', description: 'sleep 100', showInTranscript: true, canStop: true, toolCallId: 'toolu_bg' };
    expect(decodeV2SessionUpdate({ sessionUpdate: '_async_task_spawned', ...spawned }))
      .toEqual(decode({ sessionUpdate: 'async_task_spawned', ...spawned }));
    expect(decodeV2SessionUpdate({ sessionUpdate: '_async_task_state_update', asyncTaskId: 'bash_1', state: 'stopped' }))
      .toMatchObject({ kind: 'async_task_state', asyncTaskId: 'bash_1', state: 'stopped' });
    expect(decodeV2SessionUpdate({ sessionUpdate: '_async_task_progress', asyncTaskId: 'bash_1', summary: 'still' }))
      .toMatchObject({ kind: 'async_task_progress', asyncTaskId: 'bash_1', summary: 'still' });
  });
});
