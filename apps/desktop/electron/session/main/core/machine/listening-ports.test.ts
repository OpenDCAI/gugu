import { describe, expect, it } from 'vitest';
import { listListeningPorts, parseProcNetTcp, type ListeningPortsDeps } from './listening-ports';

// Real /proc/net/tcp lines (header + LISTEN on 127.0.0.1:5173, 0.0.0.0:8000, 10.0.0.5:9000, an ESTABLISHED one, another uid).
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0
   2: 0500000A:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 100 0 0 10 0
   3: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 444 1 0000000000000000 20 4 30 10 -1
   4: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 555 1 0000000000000000 100 0 0 10 0
   5: 0100007F:A000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 666 1 0000000000000000 100 0 0 10 0
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 888 1 0000000000000000 100 0 0 10 0
`;

describe('ports with a program listening on this machine', () => {
  it('keeps LISTEN sockets of this user on loopback or all interfaces only', () => {
    expect(parseProcNetTcp(TCP, 1000)).toEqual([
      { port: 5173, inode: '111' },
      { port: 8000, inode: '222' },
      { port: 40960, inode: '666' },
    ]);
    expect(parseProcNetTcp(TCP6, 1000)).toEqual([
      { port: 3001, inode: '777' },
      { port: 8000, inode: '888' },
    ]);
  });

  it("lists only ports opened from this account's sessions (agent tree, tmux, SSH terminals) — never the whole box", () => {
    const deps: ListeningPortsDeps = {
      platform: 'linux',
      uid: 1000,
      readFile: (file) => (file.endsWith('tcp6') ? TCP6 : TCP),
      processes: () => [
        // 12 = the account process (root); 10 its agent's dev server; 20 = tmux server (reparented to 1), 11 under it;
        // 30 = sshd serving the desktop's SSH terminal, 31 the shell (carries the account marker), 32 its server.
        { pid: 12, ppid: 1, name: 'node', exe: '/srv/gugu/node', cmdline: '/srv/gugu/node /srv/gugu/app/dist-electron/server.js' },
        { pid: 10, ppid: 12, name: 'node', exe: '/usr/bin/node', cmdline: 'node vite' },
        { pid: 20, ppid: 1, name: 'tmux: server', exe: '/srv/tmux', cmdline: 'tmux -L gugu-server-x new-session' },
        { pid: 11, ppid: 20, name: 'python3', exe: '/usr/bin/python3', cmdline: 'python3 -m uvicorn' },
        // Noise on a shared box: sshd, VNC, rustdesk — not in any session tree.
        { pid: 40, ppid: 1, name: 'Xtigervnc', exe: '/usr/bin/Xtigervnc', cmdline: 'Xtigervnc :1' },
      ],
      isSessionRoot: (proc) => proc.pid === 12 || proc.pid === 20,
      socketInodes: (pid) => (pid === 10 ? ['111'] : pid === 11 ? ['222', '888'] : pid === 12 ? ['666'] : pid === 40 ? ['777'] : []),
      isOwnProcess: (proc) => proc.pid === 12,
    };
    expect(listListeningPorts(deps)).toEqual({
      supported: true,
      // 3001 belongs to VNC (outside every session tree), 40960 to gugu itself: neither is listed.
      ports: [
        { port: 5173, process: 'node' },
        { port: 8000, process: 'python3' },
      ],
      // …but gugu's own port is named separately, so output mentioning it (the MCP URL in `/mcp`) is not a user service.
      ownPorts: [40960],
    });
  });

  it('says it cannot look on a machine that is not Linux', () => {
    const deps = { platform: 'darwin' } as ListeningPortsDeps;
    expect(listListeningPorts(deps)).toEqual({ supported: false, ports: [] });
  });
});
