import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * 安装进度的**量测**部件。
 *
 * 为什么要自己量：装这件事外包给了 npm / 厂商脚本，而它们不吐字节数。于是「没有进度」被
 * 当成了「拿不到进度」—— 用户盯着一个不动的圈等好几分钟，分不清它是在干活还是已经死了
 * （product spec）。第三方不报进度，进度就该由咕咕自己去测。
 *
 * 量的是**落点目录的增长**：咕咕自己拥有那个目录（`$GUGU_HOME/agents`），装进来的每一个
 * 字节都会经过它。这是一手读数，不是从别处推出来的数字。
 *
 * ❌ 不编分母：拿不到「一共该有多大」时就只报已完成量与速度，**不展示估算出来的百分比**。
 * 一条停在 87% 不动的假进度条，比没有进度条更糟。
 */

export type InstallProgressSample = {
  /** 落点目录到目前为止长了多少字节。 */
  bytesDone: number;
  /** 最近一段时间的平均速度（字节/秒）；样本不足时缺席。 */
  bytesPerSecond?: number;
  /** 按当前速度还要多久；只有分母已知且速度非零时才有。 */
  etaSeconds?: number;
};

export type InstallProgressMeterOptions = {
  /** 要盯的目录。不存在没关系 —— 安装过程中它才会被建出来。 */
  dirs: string[];
  intervalMs?: number;
  /** 一共该有多大。不知道就别传，界面会据此不画百分比。 */
  totalBytes?: number;
  onSample: (sample: InstallProgressSample) => void;
  now?: () => number;
};

const DEFAULT_INTERVAL_MS = 1_000;
/** 一次遍历最多看这么多条目 —— 目录树异常大的时候宁可读数粗一点，也不能把主进程拖住。 */
const MAX_ENTRIES_PER_WALK = 60_000;
/** 速度用最近这么长的窗口算，避免一次大文件落盘把数字打成尖峰。 */
const SPEED_WINDOW_MS = 5_000;
/**
 * 剩余时间的上限。超过这个数就不报 —— 安装刚起步那几秒里，npm 先建几个小目录，
 * 算出来的速度是每秒几百字节，除出来就是「还要 8 小时」。
 * win-dev 真机实测到过 `0.0 MB/s eta 30664s`：数字本身没错，但它说的不是事实，
 * 而这种数字比不报更伤信任（product spec「量不到就别编」）。
 */
const MAX_PLAUSIBLE_ETA_SECONDS = 6 * 60 * 60;

/**
 * 目录里 `sinceMs` 之后**改动过**的文件一共多少字节。不存在、读不动都算 0 —— 量不到不是失败，是「还没开始长」。
 *
 * 认 ctime，不认 mtime：解压归档（node、平台归档）时 tar 会把 mtime 设回发行时刻，按 mtime 这些字节整片看不见；
 * ctime 由文件系统在写入、改名、建硬链接时自己更新，谁也设不回去。于是只要没有新写入，读数就一个字节都不变，
 * 而且只增不减 —— 共用目录（aube 的 store）里本来就有的东西不算在这次安装头上。
 */
export async function measureDirBytes(dir: string, sinceMs: number): Promise<number> {
  let bytes = 0;
  let entries = 0;
  const walk = async (current: string): Promise<void> => {
    if (entries >= MAX_ENTRIES_PER_WALK) return;
    let children;
    try {
      children = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (entries >= MAX_ENTRIES_PER_WALK) return;
      entries += 1;
      // 软链不跟进去:npm 在 POSIX 上给 bin 铺的是软链,跟进去会把同一份字节数重复计进来。
      if (child.isSymbolicLink()) continue;
      const full = path.join(current, child.name);
      if (child.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const info = await stat(full);
        if (info.ctimeMs >= sinceMs) bytes += info.size;
      } catch {
        // 文件正在被写/被换名,下一轮再算。
      }
    }
  };
  await walk(dir);
  return bytes;
}

export type InstallProgressMeter = { stop: () => void };

/**
 * 起一个采样器，直到 `stop()`。
 *
 * 两条保证：
 * - **一次只跑一轮遍历**。上一轮还没回来就跳过这一拍，❌ 不让慢盘把采样堆成雪球。
 * - **只报这次装进来的**：只数开工之后改动过的文件（`measureDirBytes` 的 ctime），
 *   「已装 12.4 MB」不含目录里原本就有的。
 */
export function startInstallProgressMeter(
  options: InstallProgressMeterOptions
): InstallProgressMeter {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const history: Array<{ at: number; bytes: number }> = [];
  // 与文件的 ctime 比，用的必须是文件系统那块表，❌ 用可注入的 `now`。
  const since = Date.now();
  let walking = false;
  let stopped = false;

  const total = async (): Promise<number> => {
    const sizes = await Promise.all(options.dirs.map((dir) => measureDirBytes(dir, since)));
    return sizes.reduce((sum, size) => sum + size, 0);
  };

  const tick = async (): Promise<void> => {
    if (stopped || walking) return;
    walking = true;
    try {
      const done = await total();
      if (stopped) return;
      const at = now();
      history.push({ at, bytes: done });
      while (history.length > 1 && at - history[0]!.at > SPEED_WINDOW_MS) history.shift();

      const oldest = history[0]!;
      const spanMs = at - oldest.at;
      const sample: InstallProgressSample = { bytesDone: done };
      // `done > 0` 是门槛:一个字节都还没落地时,任何「速度」都是噪声。
      if (spanMs >= intervalMs && done > 0) {
        const perSecond = ((done - oldest.bytes) * 1000) / spanMs;
        if (perSecond > 0) {
          sample.bytesPerSecond = Math.round(perSecond);
          if (options.totalBytes && options.totalBytes > done) {
            const eta = (options.totalBytes - done) / perSecond;
            // 算得出但不可信的剩余时间不报 —— 宁可这一拍没有它。
            if (eta <= MAX_PLAUSIBLE_ETA_SECONDS) sample.etaSeconds = Math.round(eta);
          }
        }
      }
      options.onSample(sample);
    } finally {
      walking = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
