/**
 * #6264 这台机器上此刻有程序在听的端口(「端口」页签,照 VS Code Ports 视图的 process 来源:它读 /proc/net/tcp)。
 *
 * 只在人打开 / 刷新那一格时读一次,❌ 定时读。一次的代价:读 /proc/net/tcp 与 tcp6(每个套接字一行),
 * 再在**这个 Linux 用户自己的进程**里按套接字找程序名(最多看 MAX_FD_LINKS 个文件描述符,超了就不报程序名)。
 * 只报:这个账号的会话起的进程(照 VS Code:Ports 视图只自动列远端会话自己进程树里的端口 —— 终端、扩展宿主的子孙,
 * ❌ 整台机器的 sshd / VNC / 远程桌面)、在听(LISTEN)、听在本机回环或全部网卡上的端口。
 * 「会话起的进程」= 这个账号进程的子孙,加上这个账号那台 tmux 服务端的子孙(「编程」终端跑在 tmux 里,
 * tmux 服务端脱离了父进程),加上桌面经 SSH 开的「终端」(它由 sshd 起,环境里带着这个账号的
 * GUGU_SERVER_ACCOUNT;旧版桌面才这样开终端)。咕咕自己的端口(钩子 / MCP / 模型中转,在咕咕自己的进程里)不列,
 * 另报在 ownPorts 里:桌面拿它核实输出里发现的端口(照 VS Code autoForwardPortsSource: "hybrid")。
 * 2026-09-24 d22(以 root 跑)实测:按 uid 过滤会列出 22 / 5901 / 6080 / 21118 … 一整屏与会话无关的端口。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SessionpageListeningPort, SessionpageWorkspacePortsResult } from '@gugu/session-core/session-record/contract';

export const MAX_FD_LINKS = 20_000;

type Socket = { port: number; inode: string };

/** `0100007F:1F90` → { loopbackOrAny, port }。v4 是小端十六进制;v6 是 4 个小端 32 位字。 */
function parseLocalAddress(field: string): { reachable: boolean; port: number } | null {
  const [hexIp, hexPort] = field.split(':');
  if (!hexIp || !hexPort) return null;
  const port = parseInt(hexPort, 16);
  if (!Number.isInteger(port) || port <= 0) return null;
  let reachable = false;
  if (hexIp.length === 8) {
    // 127.x.x.x 的小端写法最后一个字节是 7F;0.0.0.0 全零。
    reachable = hexIp === '00000000' || hexIp.endsWith('7F');
  } else if (hexIp.length === 32) {
    const any = /^0+$/.test(hexIp);
    const loopback = hexIp === '00000000000000000000000001000000';
    // ::ffff:127.x.x.x
    const mapped = hexIp.startsWith('0000000000000000FFFF0000') && hexIp.endsWith('7F');
    reachable = any || loopback || mapped;
  }
  return { reachable, port };
}

/** /proc/net/tcp(6) 的正文 → 这个 uid 在听、够得着的套接字。 */
export function parseProcNetTcp(text: string, uid: number): Socket[] {
  const out: Socket[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    // cols: sl local rem st queues timer retrnsmt uid timeout inode
    if (cols[3] !== '0A') continue;
    if (Number(cols[7]) !== uid) continue;
    const local = parseLocalAddress(cols[1]!);
    if (!local?.reachable) continue;
    out.push({ port: local.port, inode: cols[9]! });
  }
  return out;
}

export type ListeningPortsDeps = {
  platform: NodeJS.Platform;
  uid: number;
  readFile: (file: string) => string | null;
  /** 这个用户的进程:pid、父进程、程序名、可执行文件、命令行。 */
  processes: () => Array<{ pid: number; ppid: number; name: string; exe: string; cmdline: string }>;
  /** 会话进程树的根:这个账号进程自己,以及它那台 tmux 服务端(按命令行认)。 */
  isSessionRoot: (proc: { pid: number; name: string; cmdline: string }) => boolean;
  /** 一个进程打开的套接字 inode(读 fd 目录;没权限就空)。`budget` 用完就停。 */
  socketInodes: (pid: number, budget: { left: number }) => string[];
  /** 咕咕自己的进程:可执行文件是这一份 node、命令行里带着咕咕的 app 目录。 */
  isOwnProcess: (proc: { pid: number; exe: string; cmdline: string }) => boolean;
};

export function listListeningPorts(deps: ListeningPortsDeps): SessionpageWorkspacePortsResult {
  if (deps.platform !== 'linux') return { supported: false, ports: [] };
  const sockets = [
    ...parseProcNetTcp(deps.readFile('/proc/net/tcp') ?? '', deps.uid),
    ...parseProcNetTcp(deps.readFile('/proc/net/tcp6') ?? '', deps.uid),
  ];
  if (sockets.length === 0) return { supported: true, ports: [] };
  const wanted = new Set(sockets.map((socket) => socket.inode));
  const processes = deps.processes();
  // 会话进程树:从根往下收子孙(父 → 子表一次建好,O(进程数))。
  const children = new Map<number, number[]>();
  for (const proc of processes) {
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  const inTree = new Set<number>();
  const stack = processes.filter((proc) => deps.isSessionRoot(proc)).map((proc) => proc.pid);
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (inTree.has(pid)) continue;
    inTree.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  const owner = new Map<string, { name: string; own: boolean }>();
  const budget = { left: MAX_FD_LINKS };
  for (const proc of processes) {
    if (!inTree.has(proc.pid)) continue;
    if (budget.left <= 0 || owner.size === wanted.size) break;
    const own = deps.isOwnProcess(proc);
    for (const inode of deps.socketInodes(proc.pid, budget)) {
      if (wanted.has(inode) && !owner.has(inode)) owner.set(inode, { name: proc.name, own });
    }
  }
  const byPort = new Map<number, SessionpageListeningPort>();
  const ownPorts = new Set<number>();
  for (const socket of sockets) {
    const found = owner.get(socket.inode);
    if (found?.own) ownPorts.add(socket.port);
    // 不在会话进程树里(或认不出是谁的)就不报:宁可少列,❌ 把整台机器的服务摊给人看。
    if (!found || found.own) continue;
    const existing = byPort.get(socket.port);
    if (existing && existing.process) continue;
    byPort.set(socket.port, { port: socket.port, process: found.name });
  }
  return {
    supported: true,
    ports: [...byPort.values()].sort((a, b) => a.port - b.port),
    ownPorts: [...ownPorts].sort((a, b) => a - b),
  };
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function productionListeningPortsDeps(): ListeningPortsDeps {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const appDir = process.argv[1] ? path.dirname(process.argv[1]) : '';
  // 这个账号的 tmux 服务端按 `-L <标签>` 起(server-layout.ts applyAccountEnv)。
  const tmuxLabel = process.env.GUGU_TMUX_SOCKET_LABEL ?? '';
  const accountMarker = process.env.GUGU_SERVER_ACCOUNT ? `GUGU_SERVER_ACCOUNT=${process.env.GUGU_SERVER_ACCOUNT}` : '';
  return {
    platform: process.platform,
    uid,
    readFile: readText,
    processes: () => {
      let names: string[] = [];
      try {
        names = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
      } catch {
        return [];
      }
      const out: Array<{ pid: number; ppid: number; name: string; exe: string; cmdline: string }> = [];
      for (const name of names) {
        try {
          if (fs.statSync(`/proc/${name}`).uid !== uid) continue;
        } catch {
          continue;
        }
        let exe = '';
        try {
          exe = fs.readlinkSync(`/proc/${name}/exe`);
        } catch {
          // 读不到就空
        }
        // stat 的第 4 列是父进程;程序名那一列带括号、可能含空格,从最后一个 ')' 之后数。
        const stat = readText(`/proc/${name}/stat`) ?? '';
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        out.push({
          pid: Number(name),
          ppid: Number.isInteger(ppid) ? ppid : 0,
          name: (readText(`/proc/${name}/comm`) ?? '').trim(),
          exe,
          cmdline: (readText(`/proc/${name}/cmdline`) ?? '').replace(/\0/g, ' '),
        });
      }
      return out;
    },
    socketInodes: (pid, budget) => {
      let fds: string[] = [];
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        return [];
      }
      const inodes: string[] = [];
      for (const fd of fds) {
        if (budget.left-- <= 0) break;
        try {
          const target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          const match = /^socket:\[(\d+)\]$/.exec(target);
          if (match) inodes.push(match[1]!);
        } catch {
          // fd 已经关了
        }
      }
      return inodes;
    },
    isSessionRoot: (proc) =>
      proc.pid === process.pid ||
      (!!tmuxLabel && proc.name.startsWith('tmux') && proc.cmdline.split(' ').includes(tmuxLabel)) ||
      (!!accountMarker && (readText(`/proc/${proc.pid}/environ`) ?? '').split('\0').includes(accountMarker)),
    isOwnProcess: (proc) =>
      proc.pid === process.pid || (proc.exe === process.execPath && !!appDir && proc.cmdline.includes(appDir)),
  };
}
