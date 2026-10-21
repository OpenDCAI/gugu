import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitPending } from '../../../../../../../../tests/support/awaitFact';
import {
  encodeFrame,
  encodeJsonFrame,
  FRAME,
  FrameDecoder,
  type Frame,
} from './attach-protocol';
import { serveAttachConnection, startPtyAttachServer, type AttachDeps } from './attach-server';

function fakeDeps() {
  const deps: AttachDeps = { warn: vi.fn() };
  return { deps };
}

/** 内存里的一对流:client 写的进 server,server 写的进 client。 */
function pipePair() {
  const ends: { client?: Duplex; server?: Duplex } = {};
  const end = (other: 'client' | 'server') =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        ends[other]!.push(chunk);
        cb();
      },
      final(cb) {
        ends[other]!.push(null);
        cb();
      },
    });
  ends.client = end('server');
  ends.server = end('client');
  return { client: ends.client, server: ends.server };
}

function collect(stream: NodeJS.ReadableStream) {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  stream.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)));
  return frames;
}

/**
 * 内存管道上的一轮收发(push → 'data' → 解帧 → 异步 resolve)全在 nextTick / 微任务里走完,定时器排在它们之后:
 * 等一个定时器 = 等这一轮做完,机器多慢都一样。真套接字那条不走这里 —— 数据要经内核,见 collectUntil。
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

/** 真套接字上收到的帧;`received(step, 条件)` 在某次收到数据之后条件成立时 resolve(已成立就立刻),等的是数据到达。 */
function collectUntil(stream: NodeJS.ReadableStream) {
  const decoder = new FrameDecoder();
  const frames: Frame[] = [];
  const waiters = new Set<{ holds: () => boolean; resolve: () => void }>();
  stream.on('data', (chunk: Buffer) => {
    frames.push(...decoder.push(chunk));
    for (const waiter of waiters) {
      if (!waiter.holds()) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  });
  const received = (step: string, holds: () => boolean) =>
    awaitPending(step, new Promise<void>((resolve) => {
      if (holds()) resolve();
      else waiters.add({ holds, resolve });
    }));
  return { frames, received };
}

describe('serveAttachConnection', () => {
  it('第一帧不是 L / C、或一直不说话:拒绝', async () => {
    const fake = fakeDeps();
    const a = pipePair();
    serveAttachConnection(a.server, fake.deps);
    const framesA = collect(a.client);
    a.client.write(encodeFrame(FRAME.message, 'x'));
    await flush();
    expect(JSON.parse(framesA[0]!.payload.toString())).toMatchObject({ code: 'bad_request' });

    const b = pipePair();
    serveAttachConnection(b.server, fake.deps, 10);
    const framesB = collect(b.client);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(JSON.parse(framesB[0]!.payload.toString())).toMatchObject({ code: 'bad_request' });
  });
});

describe('设备连接(L 帧,远程 SSH 的机器上桌面与它之间的一切)', () => {
  it('L 打招呼 → 回一帧空 L;之后 M 帧双向,一条连接上并发多问,推送随时来;断开时处理器收掉', async () => {
    const fake = fakeDeps();
    const handled: unknown[] = [];
    const dispose = vi.fn();
    let push: ((message: unknown) => void) | null = null;
    fake.deps.link = (send) => {
      push = send;
      return {
        handle: (message) => {
          handled.push(message);
          send({ reply: (message as { n: number }).n });
        },
        dispose,
      };
    };
    const { client, server } = pipePair();
    serveAttachConnection(server, fake.deps, 10);
    const frames = collect(client);
    client.write(encodeJsonFrame(FRAME.link, { v: 1 }));
    await flush();
    expect(frames[0]).toMatchObject({ type: FRAME.link });
    // 打过招呼就不再受「多久不说话就断」的限制(设备连接一直开着)。
    await new Promise((resolve) => setTimeout(resolve, 30));
    client.write(Buffer.concat([encodeJsonFrame(FRAME.message, { n: 1 }), encodeJsonFrame(FRAME.message, { n: 2 })]));
    await flush();
    push!({ event: 'pushed' });
    await flush();
    expect(handled).toEqual([{ n: 1 }, { n: 2 }]);
    expect(frames.slice(1).map((f) => [f.type, JSON.parse(f.payload.toString())])).toEqual([
      [FRAME.message, { reply: 1 }],
      [FRAME.message, { reply: 2 }],
      [FRAME.message, { event: 'pushed' }],
    ]);
    server.destroy();
    await flush();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('老进程(不接设备连接)回 bad_request:桌面据此说「版本太旧」', async () => {
    const fake = fakeDeps();
    const { client, server } = pipePair();
    serveAttachConnection(server, fake.deps);
    const frames = collect(client);
    client.write(encodeJsonFrame(FRAME.link, { v: 1 }));
    await flush();
    expect(frames[0]!.type).toBe(FRAME.error);
    expect(JSON.parse(frames[0]!.payload.toString())).toMatchObject({ code: 'bad_request' });
  });
});

describe('startPtyAttachServer(真的 unix 套接字)', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('套接字只有本用户能进(目录 0700、套接字 0600),连上能一问一答;旧的套接字文件被接管', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
    const dataDir = path.join(dir, 'data');
    const fake = fakeDeps();
    fake.deps.call = async (type, payload) => ({ type, payload });
    // 上一个进程留下的死套接字文件
    fs.mkdirSync(path.join(dataDir, 'run'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'run', 'pty-attach.sock'), '');
    const server = await startPtyAttachServer(dataDir, fake.deps);
    let socket: net.Socket | undefined;
    try {
      expect(fs.statSync(path.dirname(server.socketPath)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(server.socketPath).mode & 0o777).toBe(0o600);
      socket = net.connect(server.socketPath);
      const { frames, received } = collectUntil(socket);
      await new Promise((resolve) => socket!.once('connect', resolve));
      socket.write(encodeJsonFrame(FRAME.call, { v: 1, type: 'machine.openExternal', payload: { url: 'https://x' } }));
      await received('the reply reaches the client', () => frames.length >= 1);
      expect(frames[0]!.type).toBe(FRAME.reply);
      expect(JSON.parse(frames[0]!.payload.toString())).toEqual({ type: 'machine.openExternal', payload: { url: 'https://x' } });
    } finally {
      // 断言失败时也先断开客户端:server.close() 要等连接都断了才返回,否则红变成挂。
      socket?.destroy();
      await server.close();
    }
    expect(fs.existsSync(server.socketPath)).toBe(false);
  });
});
