// @@@task-web-host — 会话页宿主的 WebSocket 传输:把浏览器里的会话页当成一个"渲染窗口"接进 HostIpc。
//
// 帧的分发在 frame-host.ts(与设备连接共用);这里只管 WebSocket 这条线。协议见
// src/session/shared/lib/ipc/host-ws-protocol.ts。鉴权 = URL 上的一次性 token(启动时生成或外部传入);
// 默认只绑 127.0.0.1。这个口等于"操纵本机 agent 与 shell",所以:
//   · 桌面 app 只在非打包 + GUGU_TASK_HOST_WS=1 时才起它(owner 09-03:对安装用户必须不可用)
//   · 无头宿主(session/headless)以它为唯一传输
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  HOST_WS_DEFAULT_PORT,
  HOST_WS_HEARTBEAT_MS,
  HOST_WS_TOKEN_QUERY,
} from '@shared/lib/ipc/host-ws-protocol';
import type { HostIpc } from '../lib/host-ipc';
import { log } from '../lib/logger';
import { FrameSessionHost, type FrameSocket } from './frame-host';

/** 一条 WebSocket 当一条帧线:ws ping/pong 判活,二进制帧原样。 */
function wsFrameSocket(socket: WebSocket): FrameSocket {
  return {
    send: (frame) => {
      if (socket.readyState === socket.OPEN) socket.send(frame);
    },
    close: (reason) => {
      if (reason === 'heartbeat lost') socket.terminate();
      else socket.close(1002, reason);
    },
    onFrame: (cb) => {
      socket.on('message', (raw: RawData, isBinary: boolean) => cb(isBinary ? toBytes(raw) : rawToString(raw)));
    },
    onClose: (cb) => {
      socket.on('close', cb);
      socket.on('error', (error) => log.warn('[session-host-ws] socket error', { error: String(error) }));
    },
    ping: (onPong) => {
      socket.once('pong', onPong);
      socket.ping();
    },
  };
}

function toBytes(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw));
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function rawToString(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return raw.toString('utf8');
}

export type SessionHostWsServer = {
  hostIpc: HostIpc;
  host: string;
  port: number;
  token: string;
  /** 浏览器要连的地址(含 token)。 */
  url: string;
  close(): Promise<void>;
};

export type SessionHostWsServerOptions = {
  host?: string;
  port?: number;
  token?: string;
  /** 心跳间隔,默认 HOST_WS_HEARTBEAT_MS;测试用短值。 */
  heartbeatMs?: number;
};

export async function startSessionHostWsServer(
  options: SessionHostWsServerOptions = {}
): Promise<SessionHostWsServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? HOST_WS_DEFAULT_PORT;
  const token = options.token ?? randomBytes(24).toString('base64url');
  const hostIpc = new FrameSessionHost({ heartbeatMs: options.heartbeatMs ?? HOST_WS_HEARTBEAT_MS, label: 'session-host-ws' });

  const wss = new WebSocketServer({
    host,
    port,
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const url = new URL(req.url ?? '/', 'ws://localhost');
      return url.searchParams.get(HOST_WS_TOKEN_QUERY) === token;
    },
  });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  wss.on('connection', (socket, req) => {
    hostIpc.attach(wsFrameSocket(socket), { remote: req.socket.remoteAddress ?? '?' });
  });

  const bound = wss.address();
  const boundPort = typeof bound === 'object' && bound ? bound.port : port;
  const url = `ws://${host}:${boundPort}/?${HOST_WS_TOKEN_QUERY}=${token}`;
  log.info('[session-host-ws] listening', { host, port: boundPort });

  return {
    hostIpc,
    host,
    port: boundPort,
    token,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        hostIpc.closeAll();
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
