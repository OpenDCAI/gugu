/**
 * #6264 咕咕 server 的账号进程里的本机 unix 套接字(协议见 attach-protocol.ts 抬头),接两种连接:
 *  · 设备连接(L):远程 SSH 的机器上,桌面经 `gugu-server link` 与它之间的一切;
 *  · 一问一答(C):这台机器上的程序经 `gugu-server open-url` 等把一句话交回账号进程。
 *
 * 连接处理本身(`serveAttachConnection`)只认注入的依赖,单测拿一对内存流就能走通整条协议。
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import {
  encodeFrame,
  encodeJsonFrame,
  FRAME,
  FrameDecoder,
  parseCall,
  parseJson,
  parseLinkHello,
  ptyAttachSocketPath,
  type AttachError,
} from './attach-protocol';

export type AttachDeps = {
  warn(message: string, fields?: Record<string, unknown>): void;
  /**
   * 一问一答(C 帧):回设备 RPC 同一形状的应答。
   * 不给 = 这个进程不接这种连接(回 bad_request)。
   */
  call?(type: string, payload: unknown): Promise<unknown>;
  /**
   * 设备连接(L 帧开头,之后双向 M 帧):远程 SSH 的机器上,桌面与它之间的一切都走这一条(设备 RPC 同一张处理表、
   * 同一种信封,见 attach-protocol.ts)。send 把一条信封(应答或推送)交回这条连接;连接断了调 dispose。
   * 不给 = 这个进程不接设备连接(回 bad_request,桌面说「版本太旧」)。
   */
  link?(send: (message: unknown) => void): { handle(message: unknown): void; dispose(): void };
};

/** 连上之后多久还没说明是哪种连接,就断开。 */
export const HELLO_TIMEOUT_MS = 10_000;

export function serveAttachConnection(socket: Duplex, deps: AttachDeps, helloTimeoutMs = HELLO_TIMEOUT_MS): void {
  const decoder = new FrameDecoder();
  let closed = false;
  let helloSeen = false;
  let linked: { handle(message: unknown): void; dispose(): void } | null = null;

  const send = (frame: Buffer) => {
    if (!closed && !socket.destroyed) socket.write(frame);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(helloTimer);
    const link = linked;
    linked = null;
    if (link) {
      try {
        link.dispose();
      } catch (error) {
        deps.warn('device link: dispose failed', { error: String(error) });
      }
    }
  };
  const fail = (error: AttachError) => {
    send(encodeJsonFrame(FRAME.error, error));
    finish();
    socket.end();
  };

  const helloTimer = setTimeout(() => {
    if (!helloSeen) fail({ code: 'bad_request', message: 'no hello within timeout' });
  }, helloTimeoutMs);
  helloTimer.unref?.();

  const answer = async (call: NonNullable<AttachDeps['call']>, type: string, payload: unknown) => {
    let reply: unknown;
    try {
      reply = await call(type, payload);
    } catch (error) {
      reply = { error: { code: 'workspace_failed', message: error instanceof Error ? error.message : String(error) } };
    }
    send(encodeJsonFrame(FRAME.reply, reply));
    finish();
    socket.end();
  };

  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      return fail({ code: 'bad_request', message: error instanceof Error ? error.message : String(error) });
    }
    for (const frame of frames) {
      if (linked) {
        if (frame.type !== FRAME.message) continue;
        const message = parseJson<unknown>(frame.payload);
        if (message === null || typeof message !== 'object') {
          deps.warn('device link: message is not JSON, dropped');
          continue;
        }
        try {
          linked.handle(message);
        } catch (error) {
          deps.warn('device link: handler threw', { error: String(error) });
        }
        continue;
      }
      if (!helloSeen && frame.type === FRAME.link) {
        helloSeen = true;
        clearTimeout(helloTimer);
        const hello = parseLinkHello(frame.payload);
        if ('code' in hello) return fail(hello);
        if (!deps.link) return fail({ code: 'bad_request', message: 'this process does not accept device links' });
        try {
          linked = deps.link((message) => send(encodeJsonFrame(FRAME.message, message)));
        } catch (error) {
          return fail({ code: 'unavailable', message: error instanceof Error ? error.message : String(error) });
        }
        // 告诉对端「接上了」:之后它才开始发请求(一帧空的 L)。
        send(encodeFrame(FRAME.link));
        continue;
      }
      if (!helloSeen && frame.type === FRAME.call) {
        helloSeen = true;
        clearTimeout(helloTimer);
        const request = parseCall(frame.payload);
        if ('code' in request) return fail(request);
        if (!deps.call) return fail({ code: 'bad_request', message: 'this process does not answer calls' });
        void answer(deps.call, request.type, request.payload);
        return;
      }
      if (!helloSeen) return fail({ code: 'bad_request', message: 'first frame must be L (link) or C (call)' });
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
}

// ── 真的开一个套接字 ───────────────────────────────────────────────────────────

/** 放套接字的目录:只有本用户进得去;不是自己的(/tmp 下被别人抢先建了)就拒绝。 */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(`pty attach socket dir is not ours: ${dir}`);
  }
  fs.chmodSync(dir, 0o700);
}

export async function startPtyAttachServer(
  dataDir: string,
  deps: AttachDeps
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const socketPath = ptyAttachSocketPath(dataDir);
  ensurePrivateDir(path.dirname(socketPath));
  // 上一个进程留下的套接字文件:这个账号只有一个进程(单实例锁),留下的一定是死的。
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => serveAttachConnection(socket, deps));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  server.on('error', (error) => deps.warn('pty attach server error', { error: String(error) }));
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        fs.rmSync(socketPath, { force: true });
      }),
  };
}
