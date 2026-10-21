import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuthExpiryPersistence } from '../runtime/auth-expiry';

/**
 * #6264「登录已失效」标记的落盘:**按「这台机器 × 这家 harness 的配置家」记**,❌ 按咕咕账号记。
 *
 * 为什么:登录态住在 harness 自己的配置家里。claude 用的是这个 Linux 用户真正的 `~/.claude`,同一台机器上
 * 登着的几个咕咕账号共用这一份登录;codex 各账号有各自的影子 home(`agent-homes/codex`)。按账号记的话,
 * A 的会话发现 claude 过期了、B 那边仍显示「已登录」—— 其实是同一份登录;反过来 codex 又不该串。
 * 所以键是 `providerId|配置家的路径`,文件放在这台机器上几个账号都看得到的地方(属主算好路径递进来),
 * 每个进程只认、只改**自己那几家对应的键**,别人的原样留着。
 *
 * 读:整份读、挑自己的;写:读最新的一份 → 换掉自己的那几格 → 先写临时文件再改名(❌ 写到一半断电留下坏文件)。
 * 两个进程同一瞬间写,后写的那份可能盖掉前一份刚加的一格 —— 最坏是某一格要等下一次会话被拒再标上,
 * 不会把人说成失效。文件里只有「哪家、哪个家目录、什么时候」,❌ 任何凭据。
 */
export function homeKeyedAuthExpiryPersistence(path: string, keyFor: (providerId: string) => string): AuthExpiryPersistence {
  const SEP = '|';
  const readAll = async (): Promise<Record<string, number>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      const marks = (parsed as { expired?: unknown } | null)?.expired;
      return marks && typeof marks === 'object' ? (marks as Record<string, number>) : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  };
  const providerOf = (key: string) => (key.includes(SEP) ? key.slice(0, key.indexOf(SEP)) : key);
  /** 这一格是不是「我这个进程」的:键正好等于我给这家算出的键。老格式(只有 providerId)也算我的。 */
  const mine = (key: string) => !key.includes(SEP) || keyFor(providerOf(key)) === key;

  return {
    load: async () => {
      const all = await readAll();
      const own: Record<string, number> = {};
      for (const [key, at] of Object.entries(all)) if (mine(key) && typeof at === 'number') own[providerOf(key)] = at;
      return own;
    },
    save: async (marks) => {
      const all = await readAll().catch(() => ({}) as Record<string, number>);
      const next: Record<string, number> = {};
      for (const [key, at] of Object.entries(all)) if (!mine(key)) next[key] = at;
      for (const [providerId, at] of Object.entries(marks)) next[keyFor(providerId)] = at;
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 2, expired: next })}\n`, 'utf8');
      await rename(tmp, path);
    },
  };
}
