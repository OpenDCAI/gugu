import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  encodeJsonFrame,
  FRAME,
  FrameDecoder,
  MAX_FRAME_BYTES,
  ptyAttachSocketPath,
} from './attach-protocol';

// #6264 账号进程本机套接字的线协议(账号进程 ↔ gugu-server link / open-url)。
describe('attach 线协议', () => {
  it('帧可以被任意切块送达,拆出来的与编码前一致(含多字节 UTF-8 跨块)', () => {
    const stream = Buffer.concat([
      encodeJsonFrame(FRAME.link, { v: 1 }),
      encodeFrame(FRAME.message, '你好\r'),
      encodeFrame(FRAME.reply, Buffer.alloc(0)),
      encodeJsonFrame(FRAME.call, { cols: 120, rows: 40 }),
    ]);
    const decoder = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < stream.length; i += 3) frames.push(...decoder.push(stream.subarray(i, i + 3)));
    expect(frames.map((f) => String.fromCharCode(f.type))).toEqual(['L', 'M', 'A', 'C']);
    expect(frames[1]!.payload.toString('utf8')).toBe('你好\r');
    expect(frames[2]!.payload.length).toBe(0);
    expect(JSON.parse(frames[3]!.payload.toString())).toEqual({ cols: 120, rows: 40 });
  });

  it('超大帧当场拒绝(对端不是这个协议)', () => {
    const header = Buffer.alloc(5);
    header.writeUInt8(FRAME.message, 0);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 1);
    expect(() => new FrameDecoder().push(header)).toThrow(/too large/);
  });

  it('套接字放在账号自己的数据目录;太深时换到 /tmp 下由数据目录决定的固定位置(两端算得一样)', () => {
    const short = '/home/alice/.gugu-server/accounts/0f8b7c1e-6a3d-4c2b-9e1f-2a3b4c5d6e7f/data';
    expect(ptyAttachSocketPath(short)).toBe(`${short}/run/pty-attach.sock`);
    const deep = `/home/${'x'.repeat(60)}/.gugu-server/accounts/0f8b7c1e-6a3d-4c2b-9e1f-2a3b4c5d6e7f/data`;
    const fallback = ptyAttachSocketPath(deep);
    expect(fallback).toMatch(/^\/tmp\/gugu-pty-[0-9a-f]{16}\/pty-attach\.sock$/);
    expect(ptyAttachSocketPath(deep)).toBe(fallback);
    expect(Buffer.byteLength(fallback)).toBeLessThan(100);
  });
});
