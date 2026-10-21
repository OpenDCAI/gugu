// #6264 会话页宿主协议走「设备连接」(设备 RPC:SSH link / 咕咕云频道)时的信封:动词名、分片、按序交付。
// 宿主一侧见 electron/session/main/host-ws/device-session-host.ts,桌面一侧见 src/lib/remoteSessionHost.ts。
import { carrierToFrame, frameToCarrier, type HostFrameCarrier } from './host-ws-protocol'

export const SESSION_HOST_RPC = {
  open: 'taskhost.open',
  frame: 'taskhost.frame',
  close: 'taskhost.close',
  /** 一问一答、不开窗口:按窗口里同一张路由表跑一次 `{channel, args}`(手机回前台补齐,不必等窗口重开)。推送只走窗口。 */
  call: 'taskhost.call',
} as const;
export const SESSION_HOST_FRAME_EVENT = 'taskhost.frame';
/**
 * 宿主起来了:这台机器上一份新的会话页宿主刚订上自己的设备频道,之前开的窗口都已不在。订着这条频道的每一端(别的桌面、
 * 手机)收到就作废在路上的开线、立刻重开,❌ 干等开线超时(那一问是对着一台还没起来的机器发的,没人会答)。
 * 设备行的心跳有租约兜着,那台机器重启几秒不会经历「离线 → 在线」,别的信号认不出「它刚起来」,所以由宿主自己说。
 */
export const SESSION_HOST_READY_EVENT = 'taskhost.ready';

/**
 * 那台机器上的会话调 `open_in_tab` / 那台机器上的程序要「打开网页」:tab 开在正看着这条会话的那台电脑上
 * (remote-pane.ts 的路由)。看着 = 经这条连接订上;连接断了订阅就作废,连回来重订时攒着的照开。
 */
export const SESSION_HOST_PANE = {
  subscribe: 'taskhost-pane:subscribe',
  unsubscribe: 'taskhost-pane:unsubscribe',
  opened: 'taskhost-pane:opened',
  /** 推送:只推给订它的那条连接。 */
  open: 'taskhost-pane:open',
} as const;

/** `SESSION_HOST_PANE.subscribe` 的请求体:两头(桌面发、机器收)都按这一个形状,改名时编译期就对不上。 */
export type SessionHostPaneSubscribe = {
  subscriptionId: string;
  sessionId: string;
  browser: boolean;
  pages: boolean;
  external: boolean;
};

/** 一条推送 / 一次请求里的一片。 */
export type SessionHostPiece = HostFrameCarrier & { p?: number; n?: number };
export type SessionHostFrameBatch = { client: string; seq: number; frames: SessionHostPiece[] };

/** 单片上限(字符):咕咕云一条广播放得下,SSH 一行也不嫌长。 */
export const PIECE_CHARS = 200_000;

/** 把一批帧切成信封里的片(大帧拆成 p/n 几片,接收端 joinPieces 拼回)。 */
export function toPieces(frames: readonly (string | Uint8Array)[]): SessionHostPiece[][] {
  const batches: SessionHostPiece[][] = [];
  let current: SessionHostPiece[] = [];
  let size = 0;
  const push = (piece: SessionHostPiece, length: number) => {
    if (size + length > PIECE_CHARS && current.length > 0) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += length;
  };
  for (const frame of frames) {
    const carrier = frameToCarrier(frame);
    const text = 'f' in carrier ? carrier.f : carrier.b;
    if (text.length <= PIECE_CHARS) {
      push(carrier, text.length);
      continue;
    }
    const n = Math.ceil(text.length / PIECE_CHARS);
    for (let p = 0; p < n; p += 1) {
      const slice = text.slice(p * PIECE_CHARS, (p + 1) * PIECE_CHARS);
      push('f' in carrier ? { f: slice, p, n } : { b: slice, p, n }, slice.length);
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 收片的一侧:按到达顺序拼(调用方已按 seq 排好),拼齐一帧交出去。 */
export function createPieceJoiner(onFrame: (frame: string | Uint8Array) => void): (pieces: readonly SessionHostPiece[]) => void {
  let parts: string[] = [];
  let binary = false;
  return (pieces) => {
    for (const piece of pieces) {
      if (piece.n === undefined) {
        const frame = carrierToFrame(piece);
        if (frame !== null) onFrame(frame);
        continue;
      }
      binary = 'b' in piece;
      parts.push('f' in piece ? piece.f : piece.b);
      if (parts.length === piece.n) {
        const joined = parts.join('');
        parts = [];
        const frame = carrierToFrame(binary ? { b: joined } : { f: joined });
        if (frame !== null) onFrame(frame);
      }
    }
  };
}

/** 按 seq 交出(设备 RPC 两条线都不保证每条请求按发出的顺序处理完)。 */
export function createSeqOrderer<T>(deliver: (item: T) => void): (seq: number, item: T) => void {
  let next = 0;
  const held = new Map<number, T>();
  return (seq, item) => {
    if (seq < next) return;
    held.set(seq, item);
    while (held.has(next)) {
      const ready = held.get(next) as T;
      held.delete(next);
      next += 1;
      deliver(ready);
    }
  };
}

