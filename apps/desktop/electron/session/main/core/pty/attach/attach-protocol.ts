/**
 * #6264 咕咕 server 账号进程的**本机 unix 套接字**上的线协议。
 *
 * 这份文件是两端共用的**线协议**,纯函数、零依赖:账号进程(attach-server.ts)与 CLI
 * (electron/server/ 下的 link / open-url / match-version)都从这里取,两边各写一份就是漂移的开始。
 *
 * 帧:`[类型 1 字节][负载长度 4 字节大端][负载]`;E = 出错(JSON,随后断开)。
 *
 * 「一问一答」的连接(`gugu-server open-url`,这台机器上的程序「打开网页」):
 *   客户端第一帧发 C 请求(JSON `{v, type, payload}`)→ 账号进程回一帧 A 应答(JSON)后断开。
 *
 * 另一种是「设备连接」(`gugu-server link`,远程 SSH 的机器上桌面与它之间的一切,见 LINK_* 与 attach-server.ts):
 *   客户端第一帧发 L(JSON `{v}`)→ 之后双向都是 M 帧,负载是与云端设备 RPC **逐字相同**的 JSON 信封:
 *   客户端发请求 `{type, request_id, payload}`,账号进程回应答 `{type: '<type>:reply', request_id, result?, error?}`,
 *   以及不带 request_id 的推送事件。连接一直开着,一条连接上并发多问。不认识 L 的老进程回 E bad_request。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ATTACH_PROTOCOL_VERSION = 1;

export const FRAME = {
  error: 0x45, // 'E'
  call: 0x43, // 'C'
  reply: 0x41, // 'A'
  link: 0x4c, // 'L'
  message: 0x4d, // 'M'
} as const;

export type FrameType = (typeof FRAME)[keyof typeof FRAME];

export type Frame = { type: number; payload: Buffer };

/** 单帧上限。超过 = 对端不是我们的协议,当场断。 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

const HEADER_BYTES = 5;

export function encodeFrame(type: FrameType, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

export function encodeJsonFrame(type: FrameType, value: unknown): Buffer {
  return encodeFrame(type, JSON.stringify(value));
}

/** 流式拆帧:TCP/unix 流不保证一次 data 正好一帧,半帧留着等下一块。 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Frame[] = [];
    while (this.pending.length >= HEADER_BYTES) {
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${length} bytes`);
      if (this.pending.length < HEADER_BYTES + length) break;
      frames.push({
        type: this.pending.readUInt8(0),
        payload: this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length),
      });
      this.pending = this.pending.subarray(HEADER_BYTES + length);
    }
    return frames;
  }
}

// ── 各帧的负载 ────────────────────────────────────────────────────────────────

export type AttachErrorCode =
  /** 设备连接接不上(账号进程这一侧装配失败)。 */
  | 'unavailable'
  /** 客户端说的话不合协议(缺字段、不是 JSON)。 */
  | 'bad_request'
  /**
   * 设备连接(L)两端说的协议版本对不上 —— 这是**唯一**让桌面判「版本太旧、替它升级」的拒绝(见 LINK_EXIT.protocolMismatch);
   * 其它任何拒绝都照实报,❌ 升级(owner 2026-09-25:「升级只能是因为版本问题,而不是因为连不上」)。
   */
  | 'protocol_mismatch';

export type AttachError = {
  code: AttachErrorCode;
  message: string;
  /** 只有 protocol_mismatch 带:账号进程自己说的版本、对端打招呼时说的版本。 */
  protocol?: { server: number; client: number };
};

/**
 * #6264 一问一答里「这台机器上的程序要打开网页」那一问(`gugu-server open-url` → 账号进程,见
 * session-timeline/remote-open-external.ts)。只走本机套接字,❌ 进云端设备 RPC 那张表。
 */
export const OPEN_EXTERNAL_CALL = 'machine.openExternal';

/**
 * 经这个套接字说话的 CLI(link / open-url / match-version)的退出码(桌面据此判断「会不会自己好」,❌ 去匹配那边打的中文)。
 * 0 = 正常断开;1 = 参数 / 协议出错;2 = 用法错(老版本对不认识的命令也是 2)。
 */
export const ATTACH_EXIT = {
  /** 连不上账号进程(没在跑 / 正在重启升级):常驻服务会把它拉起来。 */
  serverNotRunning: 3,
  /** 账号进程拒绝了(原因照实报)。 */
  refused: 4,
  /** 这台机器上没登着这个咕咕账号。 */
  notSignedIn: 5,
} as const;

export function parseJson<T>(payload: Buffer): T | null {
  try {
    return JSON.parse(payload.toString('utf8')) as T;
  } catch {
    return null;
  }
}

// ── 一问一答(open-url)────────────────────────────────────────────────────

export type AttachCall = { v: number; type: string; payload: unknown };

const RPC_TYPE = /^[A-Za-z0-9_.-]{1,128}$/;

export function parseCall(payload: Buffer): AttachCall | AttachError {
  const value = parseJson<Partial<AttachCall>>(payload);
  if (!value || typeof value !== 'object') return { code: 'bad_request', message: 'call is not JSON' };
  if (value.v !== ATTACH_PROTOCOL_VERSION) {
    return { code: 'bad_request', message: `unsupported attach protocol version: ${String(value.v)}` };
  }
  if (typeof value.type !== 'string' || !RPC_TYPE.test(value.type)) {
    return { code: 'bad_request', message: 'call type is missing or malformed' };
  }
  return { v: value.v, type: value.type, payload: value.payload ?? {} };
}

// ── 设备连接(link)─────────────────────────────────────────────────────────────

export type LinkHello = { v: number };

export function parseLinkHello(payload: Buffer): LinkHello | AttachError {
  const value = parseJson<Partial<LinkHello>>(payload);
  if (!value || typeof value !== 'object') return { code: 'bad_request', message: 'link hello is not JSON' };
  if (typeof value.v !== 'number' || !Number.isInteger(value.v)) {
    return { code: 'bad_request', message: 'link hello has no protocol version' };
  }
  if (value.v !== ATTACH_PROTOCOL_VERSION) {
    return {
      code: 'protocol_mismatch',
      message: `link protocol mismatch: this process speaks ${ATTACH_PROTOCOL_VERSION}, peer speaks ${value.v}`,
      protocol: { server: ATTACH_PROTOCOL_VERSION, client: value.v },
    };
  }
  return { v: value.v };
}

/**
 * `gugu-server link` 在标准输出上先打这一行,之后才是二进制帧。桌面丢掉它之前的一切:
 * 非交互 SSH 也会 source 用户的 rc,conda / nvm / `echo 欢迎` 会先打到同一个标准输出里(rc 里的输出与帧混在一起)。
 */
export const LINK_READY_MARK = '__GUGU_LINK_READY__';

/**
 * `gugu-server link` 在标准输出上、紧挨 LINK_READY_MARK 之前报的一行:`<标记> <REMOTE_PROTOCOL_VERSION>`,
 * 这份 server 说的桌面↔server 协议。桌面据此判「版本太旧」(明确的版本信号);老版本不报 = 不知道,❌ 下结论。
 */
export const LINK_PROTOCOL_MARK = '__GUGU_LINK_PROTOCOL__';

/**
 * 账号进程回 protocol_mismatch 时,CLI 在标准错误上打的一行:`<标记> server=<n> client=<n>`。
 * 桌面要同时看到它和 LINK_EXIT.protocolMismatch 才判「版本太旧」—— 退出码 6 也可能是 rc 里别的东西。
 */
export const LINK_PROTOCOL_MISMATCH_MARK = '__GUGU_LINK_PROTOCOL_MISMATCH__';

/**
 * `gugu-server link` 的退出码(与 ATTACH_EXIT 同一张:3 没在跑、4 账号进程拒绝了(原因任意,照实报)、5 没登这个账号)。
 * 2 = 用法错,老版本对不认识的命令也是 2(配上「不认识的命令:link」= 太旧);
 * 6 = 账号进程与这条命令说的设备连接协议对不上(配上 LINK_PROTOCOL_MISMATCH_MARK = 太旧)。
 * 只有这两种算版本信号,桌面才替它升级;其余一律照实报原因。
 */
export const LINK_EXIT = { ...ATTACH_EXIT, usage: 2, protocolMismatch: 6 } as const;

// ── 套接字放在哪 ──────────────────────────────────────────────────────────────

/** unix 套接字路径上限:Linux 108、macOS 104 字节(含结尾 0)。留余量。 */
const SOCKET_PATH_LIMIT = 100;

/**
 * 这个账号的 attach 套接字。放在账号自己的数据目录里一个只有本用户进得去的子目录(0700)下 ——
 * 同一台机器上别的 Linux 用户连不上;同一个 Linux 用户下的两个咕咕账号各有各的套接字。
 *
 * 数据目录太深(路径超过 unix 套接字上限)时换到 `/tmp/gugu-pty-<数据目录的哈希>/`。
 * ⚠️ 用固定的 /tmp 而不是 os.tmpdir():账号进程(系统服务起的)与 CLI(SSH 登录 shell 起的)
 * 的 TMPDIR 不一定相同,两边必须算出同一个路径。
 */
export function ptyAttachSocketPath(dataDir: string): string {
  const preferred = path.join(dataDir, 'run', 'pty-attach.sock');
  if (Buffer.byteLength(preferred, 'utf8') <= SOCKET_PATH_LIMIT) return preferred;
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  return path.posix.join('/tmp', `gugu-pty-${hash}`, 'pty-attach.sock');
}
