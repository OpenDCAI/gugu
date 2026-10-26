// @@@remote-pty-pacer — 别的电脑经「设备连接」看着的终端:实时输出合帧、限速,落后太多就改发最新一屏。
//
// Device-connection frames share a finite link: coalescing alone does not bound a flooding terminal's bytes.
// This layer handles pty:data events only; ACP terminal LiveLogs/tool updates are separate streams.
// SSH/cloud routing stays with the existing device link. On this connection:
// - 每 REMOTE_PTY_FLUSH_MS 把同一个终端攒下的输出合成一帧发(本机是 16 ms 一帧);
// - 整条连接一个令牌桶:平均 REMOTE_PTY_BYTES_PER_SEC,允许 REMOTE_PTY_BURST 的突发;
// - 一帧放不下 = 落后了:丢掉攒着的输出,等到一屏所需的预算,发「整屏重置 + 此刻这一屏」(主进程那块屏幕的快照,pty-screen.ts)。
//   人看到的是最新画面,中间刷过去的那些帧不发 —— 与 mosh 发屏幕状态而不是每个字节同一个道理。
// 别的帧原样直发;发之前先把攒着的终端输出发掉,保证顺序(终端退出那一声不会跑到它最后几行前面)。
import type { HostWsServerMessage } from '@shared/lib/ipc/host-ws-protocol';
import type { PtyScreenSnapshot } from '../core/pty/pty-screen';
import { log } from '../lib/logger';

export const REMOTE_PTY_FLUSH_MS = 100;
export const REMOTE_PTY_BYTES_PER_SEC = 8 * 1024;
export const REMOTE_PTY_BURST = 32 * 1024;

const PTY_DATA_PREFIX = 'pty:data.';
/** RIS:终端整个复位,随后的快照从一块白屏画起(快照自己恢复各模式)。 */
const FULL_RESET = '\x1bc';

type Send = (message: HostWsServerMessage) => void;

type Stream = {
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** 落后了,等着发整屏;这期间到的输出都会在那一屏里。 */
  behind: boolean;
};

export type RemotePtyPacer = {
  outgoing(message: HostWsServerMessage, send: Send): void;
  unsubscribe(channel: string): void;
  dispose(): void;
};

export function createRemotePtyPacer(deps: {
  screenSnapshot: (ptySessionId: string) => Promise<PtyScreenSnapshot | null>;
  now?: () => number;
}): RemotePtyPacer {
  const now = deps.now ?? (() => Date.now());
  const streams = new Map<string, Stream>();
  let tokens = REMOTE_PTY_BURST;
  let refilledAt = now();
  let disposed = false;

  const refill = () => {
    const t = now();
    tokens = Math.min(REMOTE_PTY_BURST, tokens + ((t - refilledAt) / 1000) * REMOTE_PTY_BYTES_PER_SEC);
    refilledAt = t;
  };

  const resync = (channel: string, stream: Stream, send: Send, requiredBytes = 0) => {
    refill();
    // Wait for the actual screen size, not the whole burst (which would freeze input echo for 4 s).
    const goal = Math.min(requiredBytes, REMOTE_PTY_BURST);
    const wait = Math.max(0, ((goal - tokens) / REMOTE_PTY_BYTES_PER_SEC) * 1000);
    stream.timer = setTimeout(() => {
      stream.timer = null;
      void deps.screenSnapshot(channel.slice(PTY_DATA_PREFIX.length)).then((snapshot) => {
        if (disposed || streams.get(channel) !== stream) return;
        if (!snapshot) { stream.behind = false; return; }
        const data = FULL_RESET + snapshot.data + snapshot.live;
        const bytes = Buffer.byteLength(data, 'utf8');
        refill();
        if (bytes > tokens && tokens < REMOTE_PTY_BURST) {
          // This screen no longer fits. Re-read the current screen when its budget is available.
          resync(channel, stream, send, bytes);
          return;
        }
        stream.pending = '';
        stream.behind = false;
        tokens -= bytes;
        send({ t: 'event', channel, data });
      }, (error: unknown) => {
        if (disposed || streams.get(channel) !== stream) return;
        stream.behind = false;
        log.warn('[remote-pty] screen snapshot failed', { channel, error: String(error) });
      });
    }, Math.ceil(wait));
  };

  const flush = (channel: string, stream: Stream, send: Send) => {
    if (stream.timer !== null && !stream.behind) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
    if (stream.behind) {
      stream.pending = '';
      return;
    }
    if (!stream.pending) return;
    refill();
    const bytes = Buffer.byteLength(stream.pending, 'utf8');
    if (bytes <= tokens) {
      tokens -= bytes;
      const data = stream.pending;
      stream.pending = '';
      send({ t: 'event', channel, data });
      return;
    }
    stream.pending = '';
    stream.behind = true;
    resync(channel, stream, send);
  };

  return {
    outgoing(message, send) {
      if (disposed) return;
      if (message.t === 'event' && message.channel.startsWith(PTY_DATA_PREFIX) && typeof message.data === 'string') {
        let stream = streams.get(message.channel);
        if (!stream) streams.set(message.channel, (stream = { pending: '', timer: null, behind: false }));
        if (stream.behind) return;
        stream.pending += message.data;
        if (stream.timer === null) {
          const current = stream;
          stream.timer = setTimeout(() => {
            current.timer = null;
            flush(message.channel, current, send);
          }, REMOTE_PTY_FLUSH_MS);
        }
        return;
      }
      for (const [channel, stream] of streams) flush(channel, stream, send);
      send(message);
    },
    unsubscribe(channel) {
      const stream = streams.get(channel);
      if (stream?.timer !== null && stream?.timer !== undefined) clearTimeout(stream.timer);
      streams.delete(channel);
    },
    dispose() {
      disposed = true;
      for (const stream of streams.values()) if (stream.timer !== null) clearTimeout(stream.timer);
      streams.clear();
    },
  };
}
