/**
 * #6264 咕咕 server 上的程序要「打开网页」(`$BROWSER` / `xdg-open`,如 `gh auth login --web`、`vite --open`、
 * codex / claude 的登录回跳页):这台机器没有屏幕,照 VS Code 远端的做法 —— server 给它起的进程设
 * `BROWSER=<助手脚本>`(extensionHostConnection.ts),脚本把网址经本机套接字交回来,再转到**人这一侧**打开
 * (server.cli.ts 的 openExternal)。咕咕里「人这一侧」= 正看着这条会话(没有就是最近看过这台机器)的那台桌面,
 * 走 `session_open_in_tab` 同一条路由(remote-pane.ts,目标 `external`):那台桌面决定开进会话的浏览器格还是系统浏览器,
 * 网址里的 localhost 回调端口顺手经 SSH 转过去(VS Code 1.88「Port forwarding in query」)。
 *
 * 这里是纯逻辑(路由、会话目录、文件核对都注入,单测钉每条分支):
 *  · 认出是哪条会话:agent 的终端腿带 `GUGU_PTY_ID`(里面有会话 id);否则按当前目录落在哪条会话的工作目录里
 *    (最深的那个;同一个目录上好几条会话时优先有人正看着的);都认不出 = 交给最近看着这台机器的桌面。
 *  · 网址只认 http / https;给的是文件(`$BROWSER report.html`)⇒ 只认会话工作目录里的文件,
 *    交给桌面的浏览器格渲染(与 open_in_tab 的 `file:` 网页同一道围栏)。
 */
import { containsMachinePath, isAbsoluteMachinePath } from '@main/core/files/path-utils';
import { machinePathToFileUrl } from '@shared/preview/remote-page-url';
import type { SessionpagePaneTarget } from '@gugu/session-core/session-record/contract';
import { RemotePaneError, remotePaneQueuedNote, type RemotePaneRoute } from './remote-pane';

export { OPEN_EXTERNAL_CALL } from '../pty/attach/attach-protocol';

export type OpenExternalRequest = {
  /** 程序给的那个参数:网址,或一个文件路径。 */
  target: string;
  /** 助手脚本被调起时的当前目录(相对路径据它解析,也据它认会话)。 */
  cwd: string;
  /** agent 终端腿的 `GUGU_PTY_ID`(没有就空)。 */
  ptyId: string;
};

export type OpenExternalReply =
  | { outcome: 'opened' }
  | { outcome: 'queued'; note: string };

export class OpenExternalError extends Error {
  constructor(
    readonly code: 'unsupported' | 'outside_workspace' | 'not_a_file' | 'no_session',
    message: string
  ) {
    super(message);
    this.name = 'OpenExternalError';
  }
}

export type SessionRoot = { sessionId: string; root: string };

export type OpenExternalDeps = {
  route: Pick<RemotePaneRoute, 'open' | 'watching'>;
  /** `GUGU_PTY_ID` → 会话 id(认不出 = null)。 */
  sessionFromPtyId: (ptyId: string) => string | null;
  /** 这台机器上每条会话的工作目录(按最近用过的在前)。 */
  sessionRoots: () => Promise<SessionRoot[]>;
  /** 这个路径是不是一个文件。 */
  isFile: (path: string) => Promise<boolean>;
};

const HTTP_URL = /^https?:\/\//i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function trimSlash(dir: string): string {
  return dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
}

/** 当前目录落在哪条会话的工作目录里:最深的那个;一样深时优先有人正看着的,再按给的先后。 */
export function pickSessionForCwd(
  cwd: string,
  roots: readonly SessionRoot[],
  watching: (sessionId: string) => boolean
): string | null {
  let best: SessionRoot | null = null;
  for (const candidate of roots) {
    if (!candidate.root || !containsMachinePath(candidate.root, cwd)) continue;
    if (!best) {
      best = candidate;
      continue;
    }
    const depth = trimSlash(candidate.root).length;
    const bestDepth = trimSlash(best.root).length;
    if (depth > bestDepth || (depth === bestDepth && watching(candidate.sessionId) && !watching(best.sessionId))) {
      best = candidate;
    }
  }
  return best?.sessionId ?? null;
}

/** 参数 → 网址,或这台机器上的绝对路径(相对路径按 cwd 解析)。其余协议(mailto: 之类)不接。 */
export function classifyOpenTarget(raw: string, cwd: string): { url: string } | { path: string } {
  const value = raw.trim();
  if (HTTP_URL.test(value)) {
    try {
      return { url: new URL(value).toString() };
    } catch {
      throw new OpenExternalError('unsupported', `not a valid web address: ${value}`);
    }
  }
  if (value.toLowerCase().startsWith('file:')) {
    try {
      return { path: decodeURIComponent(new URL(value).pathname) };
    } catch {
      throw new OpenExternalError('unsupported', `not a valid file address: ${value}`);
    }
  }
  if (URL_SCHEME.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    throw new OpenExternalError('unsupported', `only web pages (http / https) can be opened on your computer: ${value}`);
  }
  if (!value) throw new OpenExternalError('unsupported', 'nothing to open');
  if (isAbsoluteMachinePath(value)) return { path: value };
  return { path: `${trimSlash(cwd)}/${value.replace(/^\.\//, '')}` };
}

export async function openExternalFromMachine(request: OpenExternalRequest, deps: OpenExternalDeps): Promise<OpenExternalReply> {
  const classified = classifyOpenTarget(request.target, request.cwd);
  const fromPty = request.ptyId ? deps.sessionFromPtyId(request.ptyId) : null;
  const roots = await deps.sessionRoots();
  const sessionId = fromPty ?? pickSessionForCwd(request.cwd, roots, (id) => deps.route.watching(id)) ?? '';

  let target: SessionpagePaneTarget;
  if ('url' in classified) {
    target = { kind: 'external', url: classified.url };
  } else {
    // 文件:只认会话工作目录里的(桌面的浏览器格经会话工作区的读文件动词取字节,围栏就是这个目录)。
    const root = roots.find((entry) => entry.sessionId === sessionId)?.root;
    if (!root) {
      throw new OpenExternalError('no_session', `cannot tell which Gugu session this file belongs to: ${classified.path}`);
    }
    if (!containsMachinePath(root, classified.path)) {
      throw new OpenExternalError('outside_workspace', `only files inside the session folder (${root}) can be opened: ${classified.path}`);
    }
    if (!(await deps.isFile(classified.path))) {
      throw new OpenExternalError('not_a_file', `not a file: ${classified.path}`);
    }
    const url = machinePathToFileUrl(classified.path);
    if (!url) throw new OpenExternalError('not_a_file', `not a file: ${classified.path}`);
    target = { kind: 'browser', url };
  }

  const outcome = await deps.route.open(sessionId, target, 'pinned');
  return 'queued' in outcome ? { outcome: 'queued', note: remotePaneQueuedNote(outcome) } : { outcome: 'opened' };
}

/** 套接字那头的应答:成功 `{ result }`,失败 `{ error: { code, message } }`(message 是英文、给程序和人看的那一句)。 */
export async function answerOpenExternal(
  payload: unknown,
  deps: OpenExternalDeps
): Promise<{ result: OpenExternalReply } | { error: { code: string; message: string } }> {
  const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const target = typeof body.target === 'string' ? body.target : '';
  const cwd = typeof body.cwd === 'string' && body.cwd.startsWith('/') ? body.cwd : '/';
  const ptyId = typeof body.ptyId === 'string' ? body.ptyId : '';
  try {
    return { result: await openExternalFromMachine({ target, cwd, ptyId }, deps) };
  } catch (error) {
    if (error instanceof OpenExternalError || error instanceof RemotePaneError) {
      return { error: { code: error.code, message: error.message } };
    }
    return { error: { code: 'open_failed', message: error instanceof Error ? error.message : String(error) } };
  }
}
