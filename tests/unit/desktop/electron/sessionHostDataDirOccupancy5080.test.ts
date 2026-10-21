// @@@5080 「这份数据目录还有别的活宿主在用吗」——开机收残之前的那道闸。
//
// 它防的失败模式只有一个:**两个宿主共用一份数据时,后启动的那个把先启动的那个正在干活的 agent
// 判成停止、正在发的消息判成失败**(不可撤)。owner 的用法是「不同时开两个」,这道闸是那条纪律的闸。
//
// ⚠️ 最危险的读数是「该拦时放行」——静默、不可撤。所以每条阳控都要真造一个**活着的** pid,
// 而不是随便挑个数字;而阴控要真造一个**确知已死的** pid(否则「不拦」可能只是因为判据整体失灵)。
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { claimDataDir, dataDirHeldByAnotherHost, releaseDataDir } = await import(
  '../../../../apps/desktop/electron/session/main/core/data-dir-occupancy'
);

const LOCK = 'task-host.pid';
let dir: string;
const spawned: Array<{ pid?: number; kill: (s?: NodeJS.Signals) => boolean }> = [];

/** 造一个**确实活着**的进程,返回它的 pid。阳控要的是真活,❌ 不是一个看起来像 pid 的数字。 */
function liveProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  spawned.push(child);
  if (!child.pid) throw new Error('spawn 没给出 pid,这条阳控作废');
  return child.pid;
}

/** 造一个**确知已死**的 pid:起一个立刻退出的进程,等它退,再用它的 pid。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  if (!pid) throw new Error('spawn 没给出 pid');
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return pid;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gugu-occupancy-'));
});
afterEach(() => {
  for (const c of spawned.splice(0)) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('数据目录占用判定', () => {
  it('没有锁文件 = 没被占(❌ 不能当成「有人占着」:那会让首次启动永远收不了残)', () => {
    expect(dataDirHeldByAnotherHost(dir)).toEqual({ held: false });
  });

  it('锁文件内容坏了 = 没有可信的占用证据,按没占处理', () => {
    writeFileSync(join(dir, LOCK), 'not json at all');
    expect(dataDirHeldByAnotherHost(dir).held).toBe(false);
  });

  it('阳控:锁里是一个**真活着**的别的进程 → 判为被占(这条红了就是该拦没拦)', () => {
    const pid = liveProcess();
    writeFileSync(join(dir, LOCK), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    expect(dataDirHeldByAnotherHost(dir)).toEqual({ held: true, byPid: pid });
  });

  it('阴控:锁里那个进程**确知已死** → 判为没被占(否则一次崩溃会永久堵住收残)', async () => {
    const pid = await deadPid();
    writeFileSync(join(dir, LOCK), JSON.stringify({ pid, startedAt: new Date().toISOString() }));
    expect(dataDirHeldByAnotherHost(dir).held).toBe(false);
  });

  // ⚠️ EPERM = 进程**存在**但不归我们(别的用户跑的)——那正是「有人占着」。把它读成「不存在」
  // 会让这道闸在最该拦的时候放行,而且是静默的。
  // 这个分支在开发机上造不出真实例(root 对谁都能 kill -0),所以按「控喂给判据本身」的做法用合成输入。
  // 补这两条之前实测:把 EPERM 改成 return false,8 条判据**一条都不红** —— 这个分支当时是裸的。
  it('阳控(合成):kill 抛 EPERM = 进程存在但不归我们 → 判为被占', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    try {
      writeFileSync(join(dir, LOCK), JSON.stringify({ pid: 424242, startedAt: 'x' }));
      expect(dataDirHeldByAnotherHost(dir)).toEqual({ held: true, byPid: 424242 });
    } finally {
      spy.mockRestore();
    }
  });

  it('阴控(合成):kill 抛 ESRCH = 进程真不存在 → 判为没被占', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });
    try {
      writeFileSync(join(dir, LOCK), JSON.stringify({ pid: 424242, startedAt: 'x' }));
      expect(dataDirHeldByAnotherHost(dir).held).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('自己写的锁不算占用 —— 否则本进程会跳过自己的收残', () => {
    claimDataDir(dir);
    expect(JSON.parse(readFileSync(join(dir, LOCK), 'utf8')).pid).toBe(process.pid);
    expect(dataDirHeldByAnotherHost(dir).held).toBe(false);
  });

  it('claim 会建出不存在的目录(首启时它还没有)', () => {
    const fresh = join(dir, 'not-created-yet');
    claimDataDir(fresh);
    expect(JSON.parse(readFileSync(join(fresh, LOCK), 'utf8')).pid).toBe(process.pid);
  });

  it('release 只撤自己的那份,别人的一个字不动', () => {
    const pid = liveProcess();
    const foreign = JSON.stringify({ pid, startedAt: 'x' });
    writeFileSync(join(dir, LOCK), foreign);
    releaseDataDir(dir);
    expect(readFileSync(join(dir, LOCK), 'utf8')).toBe(foreign);
    expect(dataDirHeldByAnotherHost(dir).held).toBe(true);
  });

  it('release 撤掉自己的之后,目录重新变成没被占', () => {
    claimDataDir(dir);
    releaseDataDir(dir);
    expect(dataDirHeldByAnotherHost(dir).held).toBe(false);
  });
});
