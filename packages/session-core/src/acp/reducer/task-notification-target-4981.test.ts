/**
 * #4981 —— 一条 task_notification 说的是**哪次调用**。
 *
 * 后台跑的 Bash 命令与后台子智能体走同一条通知通道,通知本身不带类型。2026-09-06 真机:
 * 子智能体内部起了一条后台 `sleep 40`,它的通知冒上来被渲染成第二个「子智能体已完成」,
 * 行名落成任务 id `bxkfon8z4`。owner:「task_notification 需要按类型过滤……background
 * command 可能也是要放到输出卡片上」。
 *
 * 判据:按 tool_use_id 找转录里那次调用 —— 派发 → 成行;别的调用 → 归还给那张卡;
 * 对不上 → 丢弃。
 */
import { describe, expect, it } from 'vitest';
import { AcpTranscriptParser } from './parser';
import type { AgentState } from '../models/agents';
import type { TranscriptItem, TranscriptTurn } from '../models/turns';

function allItems(p: AcpTranscriptParser): TranscriptItem[] {
  const turns: readonly TranscriptTurn[] = [...p.history, ...(p.activeTurn ? [p.activeTurn] : [])];
  const out: TranscriptItem[] = [];
  const walk = (items: readonly unknown[]): void => {
    for (const raw of items) {
      const item = raw as TranscriptItem & { children?: unknown[] };
      out.push(item);
      if (Array.isArray(item.children)) walk(item.children);
    }
  };
  for (const turn of turns) walk(turn.items);
  return out;
}

const doneRows = (p: AcpTranscriptParser) =>
  allItems(p).filter((item) => item.kind === 'subagent-done-tool-call');

function launch(p: AcpTranscriptParser, toolCallId: string, agentId: string): void {
  p.pushEvent(
    {
      kind: 'subagent',
      toolCallId,
      agentId,
      title: '延迟执行 sleep 40',
      status: 'completed',
      parentToolCallId: null,
      background: true,
    } as never,
    2
  );
}

function notify(toolCallId: string, agentId: string, summary?: string) {
  return {
    kind: 'subagent_done',
    toolCallId,
    agentId,
    status: 'completed',
    ...(summary ? { summary } : {}),
  } as never;
}

describe('#4981 task_notification 找它说的那次调用', () => {
  it('阳控:派发调用的通知 → 一行「子智能体已完成」,卡上的名字是派发时的名字', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c1' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派一个' } as never, 1);
    launch(p, 'call_launch', 'a15c');
    p.pushEvent(notify('call_launch', 'a15c'), 3);
    const rows = doneRows(p) as Array<{ name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('延迟执行 sleep 40');
  });

  it('子智能体内部的后台命令:通知归还给那张命令卡,❌ 不成「子智能体已完成」', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c2' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派一个' } as never, 1);
    launch(p, 'call_launch', 'a15c');
    // 子智能体自己跑的一条后台命令 —— 子调用,挂在派发之下。
    p.pushEvent(
      {
        kind: 'tool_call',
        toolCallId: 'call_bash',
        title: 'sleep 40',
        toolKind: 'execute',
        status: 'in_progress',
        parentToolCallId: 'call_launch',
        diffs: [],
        locations: [],
      } as never,
      3
    );
    p.pushEvent(notify('call_bash', 'bxkfon8z4', 'Background command "sleep 40" completed (exit code 0)'), 4);

    expect(doneRows(p).length).toBe(0);
    const bash = allItems(p).find(
      (item) => (item as { toolCallId?: string }).toolCallId === 'call_bash'
    ) as { status: string; outputText?: string } | undefined;
    expect(bash?.status).toBe('done');
    expect(bash?.outputText).toContain('exit code 0');
  });

  it('同一个子智能体来两条通知(第二条只带 taskId)⇒ 还是一行,❌ 不出第二行', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c2b' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派一个' } as never, 1);
    launch(p, 'call_launch', 'aadb5');
    p.pushEvent(notify('call_launch', 'aadb5'), 3);
    // 第二条:供应商没带 tool-use-id,transform 用 taskId 顶上。
    p.pushEvent(notify('aadb5', 'aadb5', 'Agent "等待四十秒并回复" finished'), 4);
    const rows = doneRows(p) as Array<{ name: string; summary?: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('延迟执行 sleep 40');
    expect(rows[0].summary).toContain('finished');
  });

  it('谁也对不上的通知 → 丢弃,转录一个字不变', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c3' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派一个' } as never, 1);
    launch(p, 'call_launch', 'a15c');
    const before = JSON.stringify([p.history, p.activeTurn]);
    p.pushEvent(notify('call_unknown', 'bxkfon8z4'), 3);
    expect(JSON.stringify([p.history, p.activeTurn])).toBe(before);
    expect(doneRows(p).length).toBe(0);
  });

  it('replay 结束:还挂着「在跑」的后台派发登记为 lost,❌ 不判成败', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c4' });
    p.beginReplay(1);
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派两个' } as never, 1);
    launch(p, 'call_a', 'agent-a');
    launch(p, 'call_b', 'agent-b');
    p.pushEvent(notify('call_a', 'agent-a'), 3);
    expect(p.agents.map((a: AgentState) => a.status).sort()).toEqual(['completed', 'running']);
    p.endReplay(4);
    const byId = Object.fromEntries(p.agents.map((a: AgentState) => [a.agentId, a.status]));
    expect(byId['agent-a']).toBe('completed');
    expect(byId['agent-b']).toBe('lost');
  });

  it('阴控:活着的会话(不在 replay)里在跑的后台派发照旧 running', () => {
    const p = new AcpTranscriptParser({ sessionId: 'c5' });
    p.pushEvent({ kind: 'message', role: 'user', messageId: 'u1', text: '派一个' } as never, 1);
    launch(p, 'call_a', 'agent-a');
    p.settleTurn({ kind: 'done', reason: 'end_turn' } as never, 3);
    expect(p.agents[0].status).toBe('running');
  });
});
