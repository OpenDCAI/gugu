/**
 * 时间线存档的磁盘面。
 *
 * 为什么要有它：打开一条会话时，机器要把整份记录从头折算一遍才答得出「最近几轮是什么」。
 * 一份 18MB 的 claude 记录实测 **1713ms**，而手机上冷开一次总共才 3.5 秒左右 —— 这一项是最大的。
 * 而且它每次冷开都要重付：时间线空闲 60 秒就被拆掉（`IDLE_DISPOSE_MS`），下次打开从头再来。
 * 把折算结果存到磁盘上，下次只读文件新长出来的那一段，这一项就从 1.7 秒掉到几十毫秒。
 *
 * 三条纪律，缺一条这个缓存就会从「快」变成「错」：
 *
 * ① **存档只是捷径，任何一处对不上都要能安全退回「从头读」。** 版本、指纹、续读点，
 *    任何一格不对就当没有存档 —— 那只是慢，不是错。❌ 绝不能拿着一个过期的偏移量往下读：
 *    拼出来的是一份**缺了中间**的时间线，而它不报错、在界面上和「读得慢」分不出来。
 * ② **写要原子。** 先写同目录的临时文件再 rename —— 半截 JSON 落在正式位置上，
 *    下次开会话就是一个 parse 失败（那还算好的）或者一份被截断的历史（那就糟了）。
 * ③ **读要能忍坏文件。** 磁盘满、进程被杀、手改过，都可能留下读不出来的存档；
 *    读不出来就删掉重来，❌ 不许把异常抛给「打开会话」这条路 —— 缓存坏了不该让功能坏掉。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TimelineArchive } from '@gugu/session-core/session-record';

import { app } from 'electron';

import { log } from '@main/lib/logger';

/** 存档目录名。放在 app 自己的 userData 下，与用户的项目目录无关。 */
const DIRECTORY_NAME = 'session-timeline-archive';

/**
 * 单份存档的大小上限。
 *
 * 存档里最大的那一块是折算好的全部轮次，它随记录线性长；一份 39MB 的记录折出来约 5.5MB。
 * 给一个上限是因为**收益是有天花板的而成本没有**：省下来的永远只是「重放一次」的那点时间，
 * 而写一个几百 MB 的文件会拖住主进程、吃满磁盘。超了就不存，下次照旧从头读。
 */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** 存档总量上限：超了就按最后使用时间从旧到新删。 */
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

let rootDir: string | null = null;
let resolved = false;

/**
 * 存档目录。取不到就返回 null —— **不存档只是慢，不是错**，所以这里不 throw：
 * 一个拿不到 userData 的环境（单测、无头工具）照样应该能打开会话。
 */
function root(): string | null {
  if (resolved) return rootDir;
  resolved = true;
  try {
    rootDir = join(app.getPath('userData'), DIRECTORY_NAME);
  } catch {
    rootDir = null;
  }
  return rootDir;
}

function fileFor(sessionId: string): string | null {
  const dir = root();
  if (!dir) return null;
  // 会话 id 是 uuid；仍然挡一手路径穿越 —— 它会被拼进文件名。
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return join(dir, `${sessionId}.json`);
}

export async function loadTimelineArchive(
  sessionId: string
): Promise<TimelineArchive | null> {
  const file = fileFor(sessionId);
  if (!file) return null;
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as TimelineArchive;
    // 这里只做「像不像一份存档」这一层。真正判它还成不成立（版本、续读点对不对得上）
    // 归 timeline 与记录源自己 —— 它们才知道自己那份状态长什么样。
    if (!parsed || typeof parsed !== 'object' || typeof parsed.epoch !== 'string') {
      await dropTimelineArchive(sessionId);
      return null;
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 没有存档是常态（第一次打开这条会话），❌ 不值得记一行日志。
    if (code === 'ENOENT') return null;
    log.warn('sessionTimeline: 存档读不出来，丢掉重来', {
      sessionId,
      error: String(error),
    });
    await dropTimelineArchive(sessionId);
    return null;
  }
}

export async function saveTimelineArchive(
  sessionId: string,
  archive: TimelineArchive
): Promise<void> {
  const file = fileFor(sessionId);
  if (!file) return;
  let payload: string;
  try {
    payload = JSON.stringify(archive);
  } catch (error) {
    log.warn('sessionTimeline: 存档序列化失败，这条会话不存档', {
      sessionId,
      error: String(error),
    });
    return;
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_ARCHIVE_BYTES) {
    log.info('sessionTimeline: 存档超过上限，跳过（下次照旧整份重读）', {
      sessionId,
      bytes: Buffer.byteLength(payload, 'utf8'),
    });
    return;
  }
  try {
    await mkdir(root()!, { recursive: true });
    // 临时文件必须和目标同目录：跨设备的 rename 不是原子的，而 /tmp 常常是另一个文件系统。
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, file);
  } catch (error) {
    log.warn('sessionTimeline: 存档写不进去', { sessionId, error: String(error) });
  }
}

export async function dropTimelineArchive(sessionId: string): Promise<void> {
  const file = fileFor(sessionId);
  if (!file) return;
  await rm(file, { force: true }).catch(() => {});
}

/**
 * 把总量压回上限以内，从**最久没用过的**开始删。
 *
 * 存档是纯派生数据，删掉最坏的后果是下次那条会话慢一次 —— 所以这里可以放心地删，
 * ❌ 但不能因为「删不动」就让调用方失败。
 */
export async function pruneTimelineArchives(): Promise<void> {
  const dir = root();
  if (!dir) return;
  try {
    const names = await readdir(dir).catch(() => [] as string[]);
    const files: { path: string; bytes: number; atime: number }[] = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      const info = await stat(path).catch(() => null);
      if (!info) continue;
      files.push({ path, bytes: info.size, atime: info.mtimeMs });
      total += info.size;
    }
    if (total <= MAX_TOTAL_BYTES) return;
    files.sort((a, b) => a.atime - b.atime);
    for (const one of files) {
      if (total <= MAX_TOTAL_BYTES) break;
      await rm(one.path, { force: true }).catch(() => {});
      total -= one.bytes;
    }
  } catch (error) {
    log.warn('sessionTimeline: 存档清理失败', { error: String(error) });
  }
}
