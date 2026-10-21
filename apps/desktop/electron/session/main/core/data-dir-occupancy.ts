// @@@5080 「这份数据目录现在还有别的活宿主在用吗」。
//
// 为什么需要:开机那两段收残(`agentStatusWriter.settleAfterRestart` / `claimInterruptedDispatches`)做的是
// 「上一个进程死了,把它留下的残留状态收干净」。它们没有任何限定条件 —— 一条 UPDATE 扫全表、
// 一次 select 取全表 —— 因为在**一台机器一个宿主**的世界里,「我刚启动」就等于「库里标着正在跑的
// 都是残留」。
//
// owner 2026-09-05 定的用法是「不同时开两个;真要开两个就各用各的配置和位置」。那条规则成立时
// 上面的前提就还成立。⚠️ 但那是**纪律,不是闸** —— 危险的从来不是「故意开两个」,是「不小心开了
// 两个」(d22 上网页版是常驻服务,哪天顺手开个桌面版就撞上),而撞上的后果是**静默的**:
// 另一个宿主正在干活的 agent 被判成停了、正在发的消息被判成失败(且不可撤)。
//
// 这道闸把那个静默后果换成一句响亮的跳过:**有人占着就不收残**。收不了残的代价是几行状态过时,
// 下一次独占启动会收掉;误收别人的代价是不可撤的数据损坏。两者不对称,所以宁可不收。
//
// ❌ 不用 TTL / 心跳:那把判据挂在墙钟上(本仓零容忍的那类赛跑)。这里问的是一个能当场查准的问题 ——
// 那个 pid 还活着吗。
import fs from 'node:fs';
import path from 'node:path';
import { log } from '@main/lib/logger';

const LOCK_FILE = 'task-host.pid';

type LockRecord = { pid: number; startedAt: string };

function lockPath(userDataPath: string): string {
  return path.join(userDataPath, LOCK_FILE);
}

/**
 * 那个 pid 是不是还活着。`kill -0` 只探测、不发信号。
 *
 * ⚠️ EPERM 要当**活着**:进程存在但不归我们(别的用户跑的),那正是「有人占着」。
 * 把 EPERM 读成「不存在」会让这道闸在最该拦的时候放行。
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readLock(userDataPath: string): LockRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(userDataPath), 'utf8')) as Partial<LockRecord>;
    if (typeof raw.pid !== 'number') return null;
    return { pid: raw.pid, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '' };
  } catch {
    // 没有锁文件 / 内容坏了 = 没有可信的占用证据。❌ 不当成「有人占着」:
    // 那会让首次启动永远收不了残。
    return null;
  }
}

/**
 * 这份数据目录是不是正被**另一个活着的**宿主进程占用。
 *
 * 自己写的锁不算占用(重启后 pid 变了;同一进程内重复调也不该把自己算进去)。
 */
export function dataDirHeldByAnotherHost(userDataPath: string): { held: boolean; byPid?: number } {
  const lock = readLock(userDataPath);
  if (!lock) return { held: false };
  if (lock.pid === process.pid) return { held: false };
  if (!processAlive(lock.pid)) return { held: false };
  return { held: true, byPid: lock.pid };
}

/** 宣告本进程正在用这份数据目录。写失败只记一行 —— 它不是关键路径,失败只意味着这道闸下次不生效。 */
export function claimDataDir(userDataPath: string): void {
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(lockPath(userDataPath), JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    log.warn('could not claim the session-host data directory', {
      userDataPath,
      error: String(error),
    });
  }
}

/** 退出时撤掉自己的宣告(只撤自己的那份;别人的一个字不动)。 */
export function releaseDataDir(userDataPath: string): void {
  try {
    const lock = readLock(userDataPath);
    if (lock?.pid === process.pid) fs.rmSync(lockPath(userDataPath), { force: true });
  } catch {
    // 撤不掉无所谓:下一个启动的宿主会发现这个 pid 已经死了,照样判为没被占用。
  }
}
