import type { OwnedChild } from '../exec/owned-child';
import {
  collectDescendantProcesses,
  collectLocalProcessSnapshotAsync,
  collectLocalProcessSnapshotSync,
  type ProcessGroupMember,
} from '../pty/process-tree';

/**
 * @@@5405 一个投递进程与它拉起的引擎是**一棵树**,而 SIGKILL 只杀得掉树根。
 *
 * 现场:SIGKILL 掉 claude 的 ACP 适配器后,它拉起的 `claude` 变成 ppid=1 的孤儿(实测活过 30s
 * 仍在跑,并在 39s 后跑完了手上的工具调用),而宿主此刻已经把这一代平台令牌结算掉、把那份 0600
 * settings 文档删了 —— 孤儿再打网关,拿到的是一次没人解释得了的 401。
 *
 * 为什么把手是**进程组**而不是父子链:SIGKILL 不给根任何机会收自己的孩子,孩子当场 reparent 到
 * PID1 —— 父子链正是那一刻被摧毁的那一环,事后按 ppid 去找只会找到 init。而 POSIX 保证组长 pid
 * 在组内还有成员时不被复用,所以进程组 id 在组长死后**仍然是一个有效且唯一的地址**。
 * ⇒ spawn 当场 `detached` 把树圈成一组,退出边上按 `-pgid` 收。
 *
 * 引擎自己另开的进程组(claude 的 Bash 工具把 shell 放进它自己的组、codex 的后台终端、mimocode 的工具 shell)
 * 不在 `-pgid` 的射程内,所以还要按 ppid 补一趟**逃逸后代**。这一趟只能在父子链还完好时走:
 * 有序关闭(`signalEngineTree`)在发信号**之前**读表 —— 信号一到引擎就退,逃逸者当场 reparent 到 PID1;
 * 退出边上的 `reapEngineTree` 只赶得上「适配器被 SIGKILL、引擎还活着」那一种(#6353 实测)。
 * 同一条纪律在 pty 那侧已经写过一遍(`PosixPtyTerminator` 的 escaped descendants),这里是它在
 * ACP 传输层的同一句话。
 *
 * ⚠️ 射程的边界(mac1 实测出来的,不是推的):够得到进程组的成员 + 仍挂在某个**存活成员**之下的后代;
 * 够不到**适配器的直接子进程自己换了组**那一种 —— 它离开了这个地址空间,而它唯一的父子链随适配器
 * 一起消失(opencode 的 `opencode acp` 就是这个形状:适配器自己就是引擎,它的工具 shell 是直接子且
 * 自成一组,SIGKILL 之后 ppid=1、pgid 是自己、`sess` 在 macOS 上恒为 0 —— 三个把手一个都不指向我们)。
 * 这条边界外剩下的只会是**不持凭据**的工具子进程:令牌在引擎手里,而引擎由适配器直接拉起、不离组。
 * ⇒ 计数如实报,`0` 不是「已清理」的同义词。
 *
 * ❌ 不做定时扫描、不做开机兜底:这一层只在**退出边**被叫一次。
 *
 * 与 pty 那侧的 `PosixPtyTerminator` 有意不同:那边杀的是一个**还活着**的根(用户按了停),所以先
 * SIGTERM、给 2s 宽限再 SIGKILL。这边的根**已经死了** —— 没有谁还会被礼貌地问一句,而多等的每一秒
 * 都是一个握着即将被撤销的凭据、还在跑的引擎。⇒ 这里直接 SIGKILL,宽限在这个位置没有收件人。
 */

/** 注入口:让「杀了谁」「组里还有谁」在单测里可读,真机上就是 `process.kill` + 一次 `ps`。 */
export interface EngineTreeOps {
  isWindows: boolean;
  /** `process.kill`;负 pid = 整组。 */
  kill(pid: number, signal: NodeJS.Signals): void;
  /**
   * 一次进程表快照(不含僵尸)。
   *
   * **一次**快照回答两个问题(组里还剩谁 / 谁是他们逃逸出去的后代):两次快照可以互相矛盾 ——
   * 只在第二次里出现的成员会被整趟漏掉,而漏掉的那个正是要收的东西。
   */
  snapshot(): Promise<ProcessGroupMember[]>;
  /** 同一张表的同步读法:停树时读表与发信号必须在同一个同步步骤里(见 `signalEngineTree`)。 */
  snapshotSync(): ProcessGroupMember[];
}

export function defaultEngineTreeOps(): EngineTreeOps {
  return {
    isWindows: process.platform === 'win32',
    kill: (pid, signal) => process.kill(pid, signal),
    snapshot: () => collectLocalProcessSnapshotAsync(),
    snapshotSync: () => collectLocalProcessSnapshotSync(),
  };
}

/**
 * 停一棵引擎树:整组(Windows 上整树)由 `OwnedChild` 停,POSIX 再补上换了组的逃逸后代。
 * Windows 上 taskkill /T 沿父子链走,换组逃逸不存在。
 *
 * ⚠️ 只在 spawn 侧 `detached` 成立时才能这么用:不 detached 的话适配器与**宿主自己**同组,
 * `-pgid` 会把宿主连同其它会话一起收掉。两处必须同时成立,少一边都是灾难。
 */
export function signalEngineTree(owned: OwnedChild, signal: NodeJS.Signals, ops: EngineTreeOps): void {
  const pid = owned.child.pid;
  if (pid === undefined || ops.isWindows) {
    owned.kill(signal);
    return;
  }
  // @@@6353 逃逸后代在发信号**之前**读。信号本身就是切断它们与我们唯一联系的那一刀:引擎一退,
  // 它 setpgid 出去的工具进程(codex 的后台终端、mimocode 的工具 shell)当场 reparent 到 PID1、
  // 自成一组,退出边上的 reapEngineTree 再也看不见它(mac1 实测:codex / .mimocode 下的 `sleep 600`
  // 都以 ppid=1 活过了实例退出)。
  let escaped: ProcessGroupMember[] = [];
  let snapshotError: unknown;
  try {
    escaped = escapedDescendants(ops.snapshotSync(), pid);
  } catch (error) {
    snapshotError = error;
  }
  owned.kill(signal);
  for (const member of escaped) {
    try {
      ops.kill(member.pid, signal);
    } catch {
      /* 已经退了 —— 目标达成,不是错误 */
    }
  }
  // 组照发;读不到表只说明逃逸集合未知 —— ❌ 冒充成「没有逃逸者」。
  if (snapshotError !== undefined) {
    throw new Error(
      `signalEngineTree(${pid}): process table unreadable, escaped descendants not signalled: ${
        snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
      }`
    );
  }
}

/** 组成员的后代里自成一组、落在 `-pgid` 射程外的那些。 */
function escapedDescendants(table: ProcessGroupMember[], pid: number): ProcessGroupMember[] {
  const members = table.filter((info) => info.pgid === pid);
  return collectDescendantProcesses(
    table,
    members.map(({ pid: member }) => member)
  ).filter((info) => info.pgid !== pid && info.pid !== process.pid);
}

export interface EngineTreeReap {
  /** 这次收掉了几个仍存活的成员(不含已经退掉的树根自己)。 */
  reaped: number;
  /** 收掉的 pid,给故障归因用;不含树根。 */
  pids: number[];
  /** 无法收树的原因(Windows / 没有 pid / ps 读不到),能收就是 undefined。 */
  skipped?: 'no-pid' | 'windows';
}

/**
 * 退出边上的一次性收树:先数清还剩谁,再一次收掉,把数量报回去。
 *
 * 顺序是「先读后杀」而不是「杀完再读」:杀完再读只能读到一个空组,那个 0 既可能是「收干净了」
 * 也可能是「本来就没有」—— 两者在读数里长得一模一样,而这个计数存在的全部意义就是分开这两件事。
 */
export async function reapEngineTree(
  pid: number | undefined,
  ops: EngineTreeOps = defaultEngineTreeOps()
): Promise<EngineTreeReap> {
  if (pid === undefined) return { reaped: 0, pids: [], skipped: 'no-pid' };
  if (ops.isWindows) return { reaped: 0, pids: [], skipped: 'windows' };

  const table = await ops.snapshot();
  const members = table.filter((info) => info.pgid === pid && info.pid !== pid);
  // 引擎自己 setpgid 出去的工具 shell 不在 -pgid 射程内。适配器被 SIGKILL 时引擎还活着、ppid 链完好,
  // 这一趟正好赶得上 —— 同一份快照,所以两个答案说的是同一时刻的同一张表。
  const escaped = escapedDescendants(table, pid);
  const pids = [...new Set([...members, ...escaped].map((info) => info.pid))].filter(
    (member) => member !== pid && member !== process.pid
  );

  try {
    ops.kill(-pid, 'SIGKILL');
  } catch {
    /* 组已经空了 */
  }
  // 逃逸的那些不在 -pgid 的射程内,单独收。SIGKILL 不可屏蔽 ⇒ 调用返回即不再执行用户代码,
  // 不需要事后复核轮询(复核只会引入一个「刚杀完还没被调度」的假残留)。
  for (const member of pids) {
    try {
      ops.kill(member, 'SIGKILL');
    } catch {
      /* 已经退了 —— 目标达成,不是错误 */
    }
  }
  return { reaped: pids.length, pids };
}
