// #6264 别的机器上的端口:「端口」页签那张表怎么拼、那台机器上的程序要打开的网页里藏着哪些回调端口。纯计算,单测钉死。
//
// 表照 VS Code 的 Ports 视图:一行一个远端端口,列「端口 / 这台电脑上 / 程序 / 怎么发现的」;
// 来源合三处:转着的(主进程)、输出里发现的(主进程)、此刻有程序在听的(打开 / 刷新时问那台机器一次)。
import type { SessionpageListeningPort } from '@gugu/session-core/session-record/contract';
import { holderSource, type RemotePortSource, type RemotePortsSnapshot } from '@shared/remote-ports';
import { remoteLoopbackPort } from './remote-workspace-routing';

export type RemotePortRow = {
  remotePort: number;
  /** 转到了这台电脑的哪个端口(转好了才有)。 */
  localPort: number | null;
  state: 'ready' | 'connecting' | 'failed' | 'idle';
  sources: RemotePortSource[];
  process: string | null;
  /** 在哪条会话里发现的(没有就是 null)。 */
  sessionId: string | null;
};

const SOURCE_ORDER: readonly RemotePortSource[] = ['terminal', 'agent', 'listening', 'browser', 'login', 'manual'];

export function mergePortRows(snapshot: RemotePortsSnapshot, listening: readonly SessionpageListeningPort[]): RemotePortRow[] {
  const rows = new Map<number, RemotePortRow>();
  const row = (remotePort: number): RemotePortRow => {
    let existing = rows.get(remotePort);
    if (!existing) {
      existing = { remotePort, localPort: null, state: 'idle', sources: [], process: null, sessionId: null };
      rows.set(remotePort, existing);
    }
    return existing;
  };
  const add = (target: RemotePortRow, source: RemotePortSource) => {
    if (!target.sources.includes(source)) target.sources.push(source);
  };
  for (const forward of snapshot.forwards) {
    const target = row(forward.remotePort);
    target.state = forward.phase === 'ready' ? 'ready' : forward.phase === 'connecting' ? 'connecting' : forward.phase === 'failed' ? 'failed' : 'idle';
    target.localPort = forward.phase === 'ready' ? forward.localPort : null;
    for (const holder of forward.holders) add(target, holderSource(holder));
  }
  for (const found of snapshot.detected) {
    const target = row(found.remotePort);
    add(target, found.source);
    target.sessionId ??= found.sessionId;
  }
  for (const port of listening) {
    const target = row(port.port);
    add(target, 'listening');
    if (port.process) target.process = port.process;
  }
  for (const target of rows.values()) target.sources.sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b));
  return [...rows.values()].sort((a, b) => a.remotePort - b.remotePort);
}

/** 人在「转发」框里敲的:只认 1–65535 的整数(也认 `localhost:3000` 这种写法)。 */
export function parsePortInput(text: string): number | null {
  const match = /^(?:(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):)?(\d{1,5})\/?$/i.exec(text.trim());
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? port : null;
}

/**
 * 那台机器上的程序要打开的网页里,查询串 / 锚点里带着的「登录完跳回 localhost:端口」(`redirect_uri=http://localhost:1455/…`)。
 * 照 VS Code 1.88「Port forwarding in query」:这些端口顺手转过来,人这边的浏览器登录完才跳得回那台机器。
 */
export function loginCallbackPorts(url: string): number[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const [, value] of parsed.searchParams) values.push(value);
  if (parsed.hash) {
    try {
      values.push(decodeURIComponent(parsed.hash.slice(1)));
    } catch {
      values.push(parsed.hash.slice(1));
    }
  }
  const ports: number[] = [];
  for (const value of values) {
    for (const match of value.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s&]*)?/gi)) {
      const port = remoteLoopbackPort(match[0]);
      if (port !== null && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
}
