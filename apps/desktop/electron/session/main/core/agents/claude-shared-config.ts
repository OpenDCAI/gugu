import { link, lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

/**
 * Claude 的独立账号目录(#26)。登录凭据按配置根路径存(macOS 钥匙串 `Claude Code-credentials-<路径哈希>`、
 * 退路 `.credentials.json`),所以要同时挂两个账号就只能两个根;但根里**和账号无关**的东西是用户自己的配置,
 * 换了账号不该丢。#7306 起的根是空的 —— 用户的 settings(env、权限、hooks、`autoCompactWindow`)、
 * CLAUDE.md、skills、插件、MCP 全没了。
 *
 * 这里在每次起会话前把它们接回来:
 * - 文件与目录**按项链接**到用户根(改用户根即时生效);目录里只链接子项,账号同步下来的 `synced/` 留在本根。
 * - `.claude.json` 里登录身份(`oauthAccount`)和 MCP 混在一份文件里,❌ 整份链接 —— 只把 MCP 那几个键抄过来。
 * - 账号自己的东西(凭据、会话记录 `projects/`、缓存)一律不碰。
 *
 * 本根里已经有同名的真实文件(修复之前 Claude 自己写的)时挪进 `.gugu-replaced/`,❌ 删。
 */

const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'] as const;
const SHARED_DIRECTORIES = ['agents', 'commands', 'skills', 'output-styles', 'rules', 'plugins'] as const;
/** claude.ai 按账号(组织_用户)同步下来的插件与 skills。 */
const ACCOUNT_SCOPED_CHILDREN = new Set(['synced']);
const MCP_GLOBAL_KEYS = ['mcpServers'] as const;
const MCP_PROJECT_KEYS = ['mcpServers', 'disabledMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'] as const;
const REPLACED_DIR = '.gugu-replaced';

export type ClaudeSharedConfigPaths = {
  /** 用户自己的 Claude 配置根(`~/.claude` 或用户导出的 `CLAUDE_CONFIG_DIR`)。 */
  nativeRoot: string;
  /** 用户自己的 `.claude.json`:没导出 `CLAUDE_CONFIG_DIR` 时在 home 下,导出了就在那个根里。 */
  nativeGlobalConfig: string;
  /** 这个连接的配置根;它的 `.claude.json` 在根里。 */
  connectionRoot: string;
};

type Entry = { kind: 'file' | 'directory' | 'link'; target?: string; inode?: number } | null;

async function entryAt(path: string): Promise<Entry> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return { kind: 'link', target: await readlink(path) };
    return { kind: stats.isDirectory() ? 'directory' : 'file', inode: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 源头(跟随链接):不在 = null。 */
async function sourceAt(path: string): Promise<{ directory: boolean; inode: number } | null> {
  try {
    const stats = await stat(path);
    return { directory: stats.isDirectory(), inode: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function moveAside(paths: ClaudeSharedConfigPaths, path: string): Promise<void> {
  const destination = join(paths.connectionRoot, REPLACED_DIR, relative(paths.connectionRoot, path));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const free = (await entryAt(destination)) ? `${destination}-${Date.now()}` : destination;
  await rename(path, free);
}

/** 一项:用户根有 → 链过去;用户根没了 → 收掉之前链过去的那条。 */
async function linkEntry(paths: ClaudeSharedConfigPaths, source: string, destination: string): Promise<void> {
  const [from, to] = await Promise.all([sourceAt(source), entryAt(destination)]);
  if (!from) {
    if (to?.kind === 'link' && to.target === source) await rm(destination, { force: true });
    return;
  }
  if (to?.kind === 'link') {
    if (to.target === source) return;
    await rm(destination, { force: true });
  } else if (to?.kind === 'file' && to.inode === from.inode) {
    return; // Windows 上的硬链接:同一份文件。
  } else if (to) {
    await moveAside(paths, destination);
  }
  try {
    await symlink(source, destination, from.directory ? 'junction' : 'file');
  } catch (error) {
    // Windows 没开开发者模式时建不了文件符号链接(目录用 junction 不受限):退到硬链接,同样是同一份文件。
    if (process.platform !== 'win32' || from.directory) throw error;
    await link(source, destination);
  }
}

async function linkDirectoryChildren(paths: ClaudeSharedConfigPaths, name: string): Promise<void> {
  const source = join(paths.nativeRoot, name);
  const destination = join(paths.connectionRoot, name);
  // 用户的 `~/.claude/skills` 本身常是指向 dotfiles 的链接:按跟随链接后的样子判断。
  const sourceEntry = await sourceAt(source);
  const destinationEntry = await entryAt(destination);
  if (destinationEntry?.kind === 'link' || destinationEntry?.kind === 'file') await moveAside(paths, destination);
  if (!sourceEntry?.directory) {
    if (destinationEntry?.kind === 'directory') {
      for (const child of await readdir(destination)) await linkEntry(paths, join(source, child), join(destination, child));
    }
    return;
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const children = new Set([...(await readdir(source)), ...(await readdir(destination))]);
  for (const child of children) {
    if (ACCOUNT_SCOPED_CHILDREN.has(child)) continue;
    await linkEntry(paths, join(source, child), join(destination, child));
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function copyKeys(target: Record<string, unknown>, source: Record<string, unknown> | undefined, keys: readonly string[]): void {
  for (const key of keys) {
    if (source && key in source) target[key] = source[key];
    else delete target[key];
  }
}

/** 用户级与本地级 MCP(`claude mcp add` 的两个作用域)都在 `.claude.json` 里;只抄这几个键。 */
async function syncMcpServers(paths: ClaudeSharedConfigPaths): Promise<void> {
  const native = await readJson(paths.nativeGlobalConfig);
  if (!native) return;
  const path = join(paths.connectionRoot, '.claude.json');
  const current = (await readJson(path)) ?? {};
  const next: Record<string, unknown> = { ...current };
  copyKeys(next, native, MCP_GLOBAL_KEYS);
  const nativeProjects = objectAt(native.projects) ?? {};
  const projects: Record<string, unknown> = { ...(objectAt(current.projects) ?? {}) };
  for (const key of new Set([...Object.keys(nativeProjects), ...Object.keys(projects)])) {
    const project = { ...(objectAt(projects[key]) ?? {}) };
    copyKeys(project, objectAt(nativeProjects[key]), MCP_PROJECT_KEYS);
    if (Object.keys(project).length > 0) projects[key] = project;
    else delete projects[key];
  }
  if (Object.keys(projects).length > 0) next.projects = projects;
  else delete next.projects;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  const temporary = `${path}.gugu-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function shareClaudeConfig(paths: ClaudeSharedConfigPaths): Promise<void> {
  await mkdir(paths.connectionRoot, { recursive: true, mode: 0o700 });
  for (const name of SHARED_FILES) {
    await linkEntry(paths, join(paths.nativeRoot, name), join(paths.connectionRoot, name));
  }
  for (const name of SHARED_DIRECTORIES) await linkDirectoryChildren(paths, name);
  await syncMcpServers(paths);
}
