import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { resolveSessionTuiDeliveryToolNames } from '@gugu/session-plugins/agents';
import {
  claudeRendezvousSock,
  claudeSessionDelivery,
  clearStaleRendezvousSock,
  rendezvousListening,
  sweepStaleRendezvousSocks,
} from '../../../sessionpage/claude-session-delivery';

describe('Claude task-TUI delivery boundary', () => {
  it('exposes the shared resolver values on the delivery bridge', () => {
    expect(claudeSessionDelivery.deliveryToolNames).toEqual(
      resolveSessionTuiDeliveryToolNames('claude'),
    );
    expect(claudeSessionDelivery.deliveryToolNames).toEqual({
      message: 'mcp__plugin_gugu-product_gugu__message_send',
    });
  });
});

describe('#6264 启动时清掉 tmp 里已死会话的 rendezvous 文件', () => {
  const now = 1_000_000_000;
  const base = {
    dir: '/tmp',
    uid: 501,
    now,
  };
  it('只清自己的、是 socket、一分钟以前的、没人听的;别的一概不碰', async () => {
    const files: Record<string, { socket: boolean; uid: number; age: number; alive: boolean }> = {
      'gugu-rv-aaaa.sock': { socket: true, uid: 501, age: 3_600_000, alive: false }, // 清
      'gugu-rv-bbbb.sock': { socket: true, uid: 501, age: 3_600_000, alive: true }, // 另一个实例在用
      'gugu-rv-cccc.sock': { socket: true, uid: 502, age: 3_600_000, alive: false }, // 别人的
      'gugu-rv-dddd.sock': { socket: true, uid: 501, age: 5_000, alive: false }, // 刚起、可能还没 listen
      'gugu-rv-eeee.sock': { socket: false, uid: 501, age: 3_600_000, alive: false }, // 不是 socket
      'other.sock': { socket: true, uid: 501, age: 3_600_000, alive: false }, // 不是我们的名字
    };
    const removed: string[] = [];
    const count = await sweepStaleRendezvousSocks({
      ...base,
      list: async () => Object.keys(files),
      stat: async (path) => {
        const f = files[path.slice('/tmp/'.length)]!;
        return { isSocket: () => f.socket, uid: f.uid, mtimeMs: now - f.age };
      },
      listening: async (path) => files[path.slice('/tmp/'.length)]!.alive,
      remove: async (path) => void removed.push(path),
    });
    expect(count).toBe(1);
    expect(removed).toEqual(['/tmp/gugu-rv-aaaa.sock']);
  });
});

describe.skipIf(process.platform === 'win32')('起会话前的清理只删没人听的 rendezvous 文件', () => {
  const sessionId = `${process.pid.toString(16)}-0000-4000-8000-c1ea5e0000000`;
  const sock = claudeRendezvousSock(sessionId);

  it('有人在听(宿主重启后接回 tmux 里还活着的 claude):文件留着,照样连得上', async () => {
    const server = createServer();
    // listen 只会以两件事之一收场:listening 或 error。从前只等 listening:bind 失败(路径上已有 socket 文件 → EADDRINUSE,
    // TMPDIR 太长、超过 sun_path 104 字节 → EINVAL)时只发 error、回调永远不来,而全局 testTimeout 是 0,
    // 这个 await 就一直等下去(mac1 全量单测在这里挂过 10545 s)。两件都等,bind 不上当场红，错误写明原因。
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject).listen(sock, () => {
        server.off('error', reject);
        resolve();
      });
    });
    try {
      await clearStaleRendezvousSock(sessionId);
      expect(existsSync(sock)).toBe(true);
      expect(await rendezvousListening(sock)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('进程死了留下的文件:删掉,新进程才 bind 得上', async () => {
    // 子进程 listen 后直接退出,不 close ⇒ 留下一个没人听的 socket 文件(与崩溃同形)。
    execFileSync(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(sock)}, () => process.exit(0))`]);
    expect(existsSync(sock)).toBe(true);
    expect(await rendezvousListening(sock)).toBe(false);
    await clearStaleRendezvousSock(sessionId);
    expect(existsSync(sock)).toBe(false);
  });

  it('本来就没有:不报错', async () => {
    await expect(clearStaleRendezvousSock(sessionId)).resolves.toBeUndefined();
  });
});
