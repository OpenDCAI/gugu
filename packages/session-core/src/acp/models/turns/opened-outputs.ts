/**
 * agent 用 `session_open_in_tab` 给人打开过的文件与网页 —— 这一轮的「产出」(#7193)。
 *
 * 认的这一步放在这里(调用的数据模型旁边),三处读同一份:桌面会话页与手机会话页画附件卡
 * (session-chat-ui `state/opened-outputs.ts`),机器回答手机「把那个文件给我看看」时核对这条会话
 * 真的打开过它(session-timeline service `readOpenedFile`)。
 */
import type { TranscriptItem } from './turn';

/** 打开过的一份东西。形状与桌面「输出」列表(`SessionOutput`)相同:点卡片就是从那里重开同一份。 */
export type OpenedOutput = { kind: 'file'; path: string } | { kind: 'page'; url: string };

/**
 * 咕咕给 agent 的那台 MCP server 的名字。gugu 拉起的会话叫 `gugu`(electron/mcp/gugu-mcp-name.mjs);
 * 用户自己装的 Claude Code 插件形态叫 `plugin_<插件名>_gugu`。只认这两种,❌ 按 `open_in_tab` 子串猜 ——
 * 别的 server 恰好有个同名工具,猜错就凭空多一张卡。
 */
export function isGuguServer(server: string | undefined): boolean {
  return server === 'gugu' || (server?.startsWith('plugin_') === true && server.endsWith('_gugu'));
}

const OPEN_IN_TAB_TOOL = 'session_open_in_tab';

function parseObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(bag: Record<string, unknown> | null, key: string): string | null {
  const value = bag?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * 这一条是一次成功的打开吗;是就给出打开的是什么。失败的打开不算 —— 它留在过程里照普通工具行画,
 * 失败要看得见原因,❌ 画成一张点不开的卡。
 *
 * 取值以**工具的回答**为准(绝对路径、归一过的网址:`session-orchestration.ts` 的 openFileInTab /
 * openBrowserInTab),回答读不出来才退到入参。只请一个 App 上屏(`app_tab` 而没有 path)不算 ——
 * 那不是一份东西,从「+」随时能再开。`gugu-file://` 是群文件夹里的文件,它在群里有自己的位置,也不算。
 * 入参里的路径只在它本身是绝对路径时才用:相对路径是相对会话目录的,这里不知道会话目录,
 * 照字面记下来,手机去取时就会按别的目录解析,取到别的文件或取不到。
 */
export function openedOutputOf(item: TranscriptItem): OpenedOutput | null {
  if (item.kind !== 'mcp-tool-call') return null;
  if (item.tool !== OPEN_IN_TAB_TOOL || !isGuguServer(item.server) || item.status !== 'done') return null;
  const input = parseObject(item.rawInput);
  const answer = parseObject(item.outputText) ?? parseObject(item.rawOutput);
  const url = stringField(answer, 'url') ?? stringField(input, 'url');
  if (url) return url.startsWith('gugu-file://') ? null : { kind: 'page', url };
  const path = stringField(answer, 'path') ?? absolutePath(stringField(input, 'path'));
  return path ? { kind: 'file', path } : null;
}

/** POSIX `/x`、Windows `C:\x` / `C:/x` / `\\server\x`。其余 → null。 */
function absolutePath(path: string | null): string | null {
  return path && (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) ? path : null;
}

/** 本机文件的路径:`path` 打开的,或者用 `file://` 网址打开的那一页。其余网页 → null。 */
export function openedFilePath(output: OpenedOutput): string | null {
  if (output.kind === 'file') return output.path;
  let parsed: URL;
  try {
    parsed = new URL(output.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  try {
    const path = decodeURIComponent(parsed.pathname);
    // Windows 的 `file:///C:/x` → `C:/x`。
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

/** 同一份东西认作一张卡:同一个文件用 path 开和用 file:// 开是同一个。 */
export function openedOutputKey(output: OpenedOutput): string {
  const path = openedFilePath(output);
  return path ? `file:${path}` : `page:${output.kind === 'page' ? output.url : ''}`;
}
