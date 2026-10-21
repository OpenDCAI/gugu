import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AcpSessionPrepareContext } from '@gugu/session-core/agents/plugins';

/**
 * `config/skills.json` 另加的 skill 目录 → 咕咕托管的 `config/skills/` 里一条条软链接(#6335)。
 *
 * ## 为什么
 *
 * `skills.json` 是 agy CLI 的功能(它的 Go 语言服务器 `ScanSkillsConfigFile`;格式见 CLI 内嵌文档
 * 「entries / inherits / include_only / exclude」)。ACP 服务 1.2.1 不读它 —— `resolve_skills_paths`
 * 写死四处目录,包里连 `skills.json` 这个字符串都没有。用户在 CLI 里能用的 skill,在咕咕里就少一截。
 * ⇒ 把它列出的每个 skill 链进 ACP 服务真在读的 `$GEMINI_HOME/config/skills/`。
 *
 * ## 边界
 *
 *  · **只动咕咕托管的那份根**(路径在 `agent-homes/antigravity/` 下)。`GEMINI_HOME` 指着用户自己的根时
 *    一个字不写 —— 那是 behavior `agent-config-boundary` 的红线。
 *  · 软链接而不是拷贝:这些目录跟着用户的源目录实时变(托管根本身是首次拷一次、之后不同步)。
 *  · 已经有同名条目(拷过来的、或用户自己放的)就不碰;只清理**我们建的、指向已不存在目录**的链接。
 *  · 只接绝对路径与 `~/` 路径:相对路径按文档是「相对工作区根」,链进全局目录会串到别的工作区。
 */
const MANAGED_ROOT_MARKER = `${'/'}agent-homes${'/'}antigravity${'/'}`;

type RawEntry = { path: string; include_only?: string[]; exclude?: string[] };
/** 一个目录 + 一串过滤组;每一组都得过(条目自己一组,每层 inherits 再各加一组)。 */
type Entry = { path: string; filters: { include: RegExp[]; exclude: RegExp[] }[] };

export async function linkSkillsJsonRoots(ctx: AcpSessionPrepareContext): Promise<number> {
  const home = ctx.env.GEMINI_HOME?.trim();
  if (!home || !home.replaceAll('\\', '/').includes(MANAGED_ROOT_MARKER)) return 0;
  const skillsDir = join(home, 'config', 'skills');
  const entries = await collectEntries(join(home, 'config', 'skills.json'), ctx.homeDir, new Set());
  if (entries.length === 0) return 0;

  await mkdir(skillsDir, { recursive: true });
  const roots = new Set<string>();
  let linked = 0;
  for (const entry of entries) {
    const root = resolveHomePath(entry.path, ctx.homeDir);
    if (!root || root === skillsDir) continue;
    roots.add(root);
    for (const name of (await listDirs(root)).sort()) {
      if (!entry.filters.every((filter) => passes(filter, name))) continue;
      const source = join(root, name);
      if (!(await isFile(join(source, 'SKILL.md')))) continue;
      const link = join(skillsDir, name);
      if (await exists(link)) continue;
      await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
      linked += 1;
    }
  }
  await pruneDanglingLinks(skillsDir, roots);
  return linked;
}

async function collectEntries(file: string, homeDir: string, seen: Set<string>): Promise<Entry[]> {
  if (seen.has(file)) return [];
  seen.add(file);
  let parsed: { entries?: unknown; inherits?: unknown };
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as typeof parsed;
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const inherit of asEntries(parsed.inherits)) {
    const target = resolveHomePath(inherit.path, homeDir);
    if (!target) continue;
    const filter = toFilter(inherit);
    // 继承来的整份清单再按这一条的 include_only / exclude 收窄(文档:过滤作用在条目名上)。
    for (const entry of await collectEntries(target, homeDir, seen)) {
      out.push({ ...entry, filters: [...entry.filters, filter] });
    }
  }
  for (const entry of asEntries(parsed.entries)) out.push({ path: entry.path, filters: [toFilter(entry)] });
  return out;
}

function toFilter(entry: RawEntry): Entry['filters'][number] {
  return { include: compile(entry.include_only), exclude: compile(entry.exclude) };
}

function passes(filter: Entry['filters'][number], name: string): boolean {
  if (filter.include.length && !filter.include.some((pattern) => pattern.test(name))) return false;
  return !filter.exclude.some((pattern) => pattern.test(name));
}

function asEntries(value: unknown): RawEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is RawEntry => typeof item === 'object' && item !== null && typeof (item as RawEntry).path === 'string'
  );
}

/** 绝对路径与 `~/` 路径;相对路径(相对工作区)一律不接,理由见抬头。 */
export function resolveHomePath(path: string, homeDir: string): string | null {
  const trimmed = path.trim();
  if (trimmed === '~') return homeDir;
  if (trimmed.startsWith('~/')) return resolve(homeDir, trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : null;
}

function compile(patterns: readonly string[] | undefined): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns ?? []) {
    try {
      out.push(new RegExp(`^(?:${pattern})$`));
    } catch {
      // 写坏的模式不让整份清单失效。
    }
  }
  return out;
}

async function pruneDanglingLinks(skillsDir: string, roots: Set<string>): Promise<void> {
  for (const name of await readdir(skillsDir).catch(() => [] as string[])) {
    const link = join(skillsDir, name);
    const info = await lstat(link).catch(() => null);
    if (!info?.isSymbolicLink()) continue;
    const target = resolve(skillsDir, await readlink(link));
    const ours = [...roots].some((root) => dirname(target) === root);
    if (ours && !(await exists(target))) await unlink(link);
  }
}

async function listDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(entry.name);
    else if (entry.isSymbolicLink() && (await stat(join(dir, entry.name)).catch(() => null))?.isDirectory()) {
      out.push(entry.name);
    }
  }
  return out;
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}
