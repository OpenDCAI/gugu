import { describe, expect, it } from 'vitest';
import type { ProcessGroupMember } from '../pty/process-tree';
import type { OwnedChild } from '../exec/owned-child';
import { signalEngineTree, type EngineTreeOps } from './engine-tree';

// 形状取自 #6353 的 mac1 读数:适配器组长 100(detached)→ 引擎 101(同组)→ 引擎 setpgid 出去的
// 工具进程 200(自成一组,例如 codex 的后台终端 `sleep 600`)。300 是与这棵树无关的进程。
const row = (pid: number, ppid: number, pgid: number): ProcessGroupMember => ({ pid, ppid, pgid, state: 'S' });
const TREE = [row(100, 50, 100), row(101, 100, 100), row(200, 101, 200), row(201, 200, 200), row(300, 1, 300)];

function recordingOps(table: () => ProcessGroupMember[]) {
  const calls: string[] = [];
  const ops: EngineTreeOps = {
    isWindows: false,
    kill: (pid, signal) => void calls.push(`kill ${pid} ${signal}`),
    snapshot: async () => table(),
    snapshotSync: () => {
      calls.push('snapshot');
      return table();
    },
  };
  // 组长 100 的整组由 handle 停(POSIX 上就是发给 -100)。
  const owned = {
    child: { pid: 100 },
    kill: (signal: NodeJS.Signals) => void calls.push(`kill -100 ${signal}`),
  } as unknown as OwnedChild;
  return { ops, calls, owned };
}

describe('signalEngineTree (#6353)', () => {
  it('signals the escaped tool process together with the group, read before the signal', () => {
    const { ops, calls, owned } = recordingOps(() => TREE);
    signalEngineTree(owned, 'SIGTERM', ops);
    // 读表先于发信号:信号一到引擎就退,逃逸者的父子链随之断掉。
    expect(calls[0]).toBe('snapshot');
    expect(calls).toContain('kill -100 SIGTERM');
    // 逃逸者自己与它的后代都在(200 自成一组,201 在 200 的组里)。
    expect(calls).toContain('kill 200 SIGTERM');
    expect(calls).toContain('kill 201 SIGTERM');
    // 与这棵树无关的进程不碰。
    expect(calls.some((c) => c.startsWith('kill 300 '))).toBe(false);
  });

  it('negative control: a tool process already reparented to PID1 is out of reach (the gap this fix closes)', () => {
    // 这正是修复前退出边上看到的表:引擎已退,200 的 ppid 变成 1 —— 按父子链再也找不回来。
    const { ops, calls, owned } = recordingOps(() => [row(100, 50, 100), row(200, 1, 200)]);
    signalEngineTree(owned, 'SIGTERM', ops);
    expect(calls.some((c) => c.startsWith('kill 200 '))).toBe(false);
  });

  it('still signals the group when the table is unreadable, then fails loud instead of reporting "nothing escaped"', () => {
    const { ops, calls, owned } = recordingOps(() => {
      throw new Error('ps: timed out');
    });
    expect(() => signalEngineTree(owned, 'SIGTERM', ops)).toThrow(/escaped descendants not signalled: ps: timed out/);
    expect(calls).toContain('kill -100 SIGTERM');
  });
});
