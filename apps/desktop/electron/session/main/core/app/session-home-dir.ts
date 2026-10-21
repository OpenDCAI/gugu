import { existsSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/** vite define 在 electron 主进程包里把它换成字面量;单测里没有这个 define,用 typeof 兜住。 */
declare const __GUGU_TIER__: string | undefined;
/** 构建期烤进包里的 tier,❌ 不读 process.env.GUGU_TIER:那个用户改得动,而目录一换,任务工作区就换了一个。 */
const BUILD_TIER: string = typeof __GUGU_TIER__ === 'string' ? __GUGU_TIER__ : 'production';

/**
 * 咕咕在 `%APPDATA%` 下的 **ASCII** 目录名。`productName` 是「咕咕」,不能拿它拼给别人用的路径。
 * 按 tier 分开(#6948),与 `GUGU_HOME`(`~/.gugu-<tier>`)、tmux socket 标签(`gugu-<tier>`)同一套命名:
 * 正式版与 Beta 的 userData 本来就是两个目录(`咕咕` / `咕咕 Beta`),回退时却落到同一个 `gugu\task-home`,
 * 两边的会话共用一个工作目录,也共用 harness 按 cwd 记的转录与记忆(`~/.claude/projects/<cwd>`)。
 */
function asciiAppDir(tier: string): string {
  return tier === 'production' ? 'gugu' : `gugu-${tier}`;
}

/**
 * 交给**第三方工具**当 cwd 的路径,必须是纯 ASCII。
 *
 * 出处(2026-09-20 Windows 现场):`productName` 是「咕咕」(`package.json` / `electron-builder.cjs`),
 * 于是 Windows 上 `app.getPath('userData')` = `%APPDATA%\咕咕`,通用任务的 cwd 落在
 * `…\咕咕\task-home` —— **含非 ASCII**。咕咕给这个 cwd 发信任之后,codex 会把
 * `[projects.'…\咕咕\task-home']` 写进用户全局 `~/.codex/config.toml`;
 * 而 codex 自己是**按 GBK 读、按 UTF-8 写回**那个文件的:中文路径的最后一个 UTF-8 字节
 * 与紧跟的闭合单引号 `'`(0x27)拼成**非法 GBK 双字节序列**(GBK 尾字节须 ≥ 0x40),
 * 整对被替换成 `?` ⇒ **闭合引号被吞** ⇒ 表头关不上 ⇒ codex 报
 * `unclosed table, expected ']'`,**用户自己的 codex(CLI 与桌面端)从此加载不了配置**,
 * 而且手工改回去也不管用 —— 下一次 codex 写入又会把它写坏。
 *
 * 编解码那半是 codex 的上游 bug,我们改不了;**但触发源是我们给的,可以单方面拿掉**。
 *
 * ⚠️ 判据写成「**路径里有没有非 ASCII**」,不是「是不是 Windows」:
 * macOS/Linux 上 `userData` 同样带「咕咕」,同一条路一样会把非 ASCII 递给第三方工具;
 * 而用户若把咕咕装在 ASCII 路径下,这里**什么都不做**(返回原位),不给他平白搬一次家。
 *
 * 这里只决定**新建**任务工作区时用哪个目录:它的路径落库在隐式项目那一行里,行在就用行里的,不再经过这里
 * ⇒ 改这里不会挪动已有的会话(#6948)。`paths` 只给单测换成 `path.win32` 用。
 */
export function resolveSessionHomeDir(
  userDataDir: string,
  appDataDir: string,
  tier: string,
  paths: Pick<typeof path, 'join'> = path
): string {
  const preferred = paths.join(userDataDir, 'task-home');
  if (isPureAscii(preferred)) return preferred;
  return paths.join(appDataDir, asciiAppDir(tier), 'task-home');
}

function isPureAscii(value: string): boolean {
  // 逐码点比,不用正则:`[\x00-\x7F]` 会触发 `no-control-regex`,而为它挂一条 disable
  // 只是把规则关掉,不如换一个本来就不需要豁免的写法。
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * 通用任务(没有项目)的执行目录:app 自有存储下的 `task-home`。
 * renderer 经 `app.getSessionHomeDir` 拿的、预热池(#5327)预起会话用的,都是这一个 —— 两边各拼一份字面量
 * 的话,目录一挪就变成「预热永远认领不上」这种静默降级。
 */
export function sessionHomeDir(): string {
  return resolveSessionHomeDir(app.getPath('userData'), app.getPath('appData'), BUILD_TIER);
}

/** 旧的非 ASCII 位置(只在需要搬家时才有意义;已经是 ASCII 的装法这里恒等于新位置)。 */
export function legacySessionHomeDir(): string {
  return path.join(app.getPath('userData'), 'task-home');
}

/**
 * 一次性搬家:把旧的非 ASCII `task-home` 挪到新位置。
 *
 * 只在**新位置还不存在**且旧位置存在时动手 —— 两边都在就说明已经搬过(或用户自己造了新的),
 * ❌ 不合并、不覆盖:那是用户的工作目录,合并的失败模式比不搬家坏得多。
 * 新位置的上一级(`gugu-<tier>`)第一次用时还不存在,先建出来,否则 rename 必然 ENOENT。
 * 搬不动(占用/跨卷/权限)就**保持原样并上抛**,由调用方记日志 —— ❌ 不静默吞,
 * 否则用户会看到一个空的 task-home 而旧文件还在老地方。
 */
export function migrateLegacySessionHome(from: string, to: string): 'moved' | 'skipped' {
  if (from === to) return 'skipped';
  if (!existsSync(from) || existsSync(to)) return 'skipped';
  mkdirSync(path.dirname(to), { recursive: true });
  renameSync(from, to);
  return 'moved';
}
