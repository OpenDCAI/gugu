/**
 * #6264 一次性修复:把咕咕模型目录探针**以前**漏进用户 `~/.codex/config.toml` 的信任条目摘掉。
 *
 * 来历:探针在新建的临时目录 `<tmpdir>/gugu-model-probe-codex-XXXXXX` 里开一条 codex thread,而 codex
 * 碰到没标过信任、权限又可写的 cwd 会自己把 `[projects."<cwd>"] trust_level = "trusted"` 写进用户配置
 * (codex-rs `thread_processor.rs` → `set_project_trust_level`)。目录用完就删了,条目却一直留着,
 * 每探一次多一条(d22 实机 5 条)。根因已在插件侧按次给信任堵上(见 codex `codexProjectTrustArgs`);
 * 这里只清旧账。
 *
 * 规矩:
 *  · 只摘**咕咕自己的探针目录**那几段 —— 表名是 `projects."…/gugu-model-probe-codex-<6 位>"`,
 *    且表里除了 `trust_level = "trusted"` 和空行之外什么都没有(连注释都算「不是我们写的」)。任何一格对不上就原样不动。
 *  · 其余每一个字节保持原样(逐行处理,不经 TOML 解析再序列化 —— 那会重排用户的格式与注释)。
 *  · 没有要摘的 ⇒ 不写文件。有 ⇒ 同目录临时文件 + rename 原子替换,保留原文件权限。
 * 摘完以后再跑是空操作,所以「每个进程第一次探 codex 前跑一次」就是「一次」。
 */
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers';
import { requireNativeHome } from '@gugu/session-plugins/agents';

const PROBE_DIR_NAME = /^gugu-model-probe-codex-[A-Za-z0-9]{6}$/;
const TABLE_HEADER = /^[ \t]*\[/;
const PROJECT_HEADER = /^[ \t]*\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\][ \t]*(?:#.*)?\r?\n?$/;
const TRUSTED_LINE = /^[ \t]*trust_level[ \t]*=[ \t]*(?:"trusted"|'trusted')[ \t]*(?:#.*)?\r?\n?$/;
const BLANK = /^[ \t]*\r?\n?$/;

function isGuguProbePath(path: string): boolean {
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  return PROBE_DIR_NAME.test(base);
}

/** 纯函数:返回摘完之后的文本与摘掉的条数。没有可摘的 ⇒ 原文原样返回。 */
export function stripGuguProbeTrustEntries(text: string): { text: string; removed: number } {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let removed = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const header = PROJECT_HEADER.exec(line);
    const path = header ? (header[1] ?? header[2] ?? '') : '';
    if (!header || !isGuguProbePath(path)) {
      out.push(line);
      index += 1;
      continue;
    }
    let end = index + 1;
    let sawTrust = false;
    let clean = true;
    while (end < lines.length && !TABLE_HEADER.test(lines[end]!)) {
      if (TRUSTED_LINE.test(lines[end]!)) sawTrust = true;
      else if (!BLANK.test(lines[end]!)) clean = false;
      end += 1;
    }
    // 下一张表是这个目录自己的子表(`[projects."<同一路径>".x]`)⇒ 不是我们写的形状,不动。
    const next = lines[end];
    const nestedTable = next !== undefined && next.trimStart().startsWith(line.trim().slice(0, -1) + '.');
    if (!sawTrust || !clean || nestedTable) {
      out.push(line);
      index += 1;
      continue;
    }
    // 摘掉表头之前紧挨着的空行(它是这张表的分隔),表体末尾的空行留给下一张表当分隔。
    while (out.length > 0 && BLANK.test(out[out.length - 1]!)) out.pop();
    const body = lines.slice(index + 1, end);
    let trailingBlanks = 0;
    while (trailingBlanks < body.length && BLANK.test(body[body.length - 1 - trailingBlanks]!)) trailingBlanks += 1;
    if (next !== undefined && out.length > 0) out.push(...body.slice(body.length - trailingBlanks));
    removed += 1;
    index = end;
  }
  return removed > 0 ? { text: out.join(''), removed } : { text, removed: 0 };
}

/** 读出这台机器上 codex 的配置文件,摘掉探针漏进去的信任条目。文件不存在 ⇒ 什么都不做。 */
export async function scrubCodexProbeTrustEntries(env: Record<string, string | undefined>): Promise<number> {
  // codex 现在读的那一份配置根 = 候选的第一个。
  const [codexHome] = nativeHomeRoots(requireNativeHome('codex'), env, homedir());
  const configPath = join(codexHome, 'config.toml');
  let original: string;
  let mode: number;
  try {
    [original, mode] = await Promise.all([
      readFile(configPath, 'utf8'),
      stat(configPath).then((info) => info.mode & 0o777),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const { text, removed } = stripGuguProbeTrustEntries(original);
  if (removed === 0) return 0;
  const temp = `${configPath}.gugu-scrub-${process.pid}`;
  await writeFile(temp, text, { mode });
  await chmod(temp, mode);
  await rename(temp, configPath);
  return removed;
}
