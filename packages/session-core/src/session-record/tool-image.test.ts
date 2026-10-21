import { describe, expect, it } from 'vitest';

import type { TranscriptTurn } from '../acp/client';
import { TOOL_IMAGE_FETCH_LIMIT } from './contract';
import { findToolImage } from './tool-image';

/** owner 10-15:手机那份时间线里图只有类型和字数,图本身按 (条目, 第几张) 来取 —— 宿主据此在时间线里找。 */
describe('findToolImage', () => {
  const shot = (data: string) => ({ mimeType: 'image/jpeg', data });
  const tool = (id: string, extra: Record<string, unknown> = {}) => ({ kind: 'mcp-tool-call', id, seq: 1, toolCallId: id, title: 'app_check', status: 'done', ...extra });
  const turns = [
    { id: 't1', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'm1', seq: 0, role: 'user', text: 'check' }, tool('a', { images: [shot('A0'), shot('A1')] })] },
    { id: 't2', seq: 2, initiator: 'user', items: [tool('g', { kind: 'tool-group', children: [tool('child', { images: [shot('C0')] })] })] },
  ] as unknown as TranscriptTurn[];

  it('按条目 id 和第几张找到那一张;工具组里的子调用也认', () => {
    expect(findToolImage(turns, 'a', 1)).toEqual({ ok: true, image: shot('A1') });
    expect(findToolImage(turns, 'child', 0)).toEqual({ ok: true, image: shot('C0') });
  });

  it('找不到如实说是哪一样没有:条目不在了、这一条没有那么多张(含负数和小数)', () => {
    expect(findToolImage(turns, 'gone', 0)).toMatchObject({ ok: false, code: 'no_such_item' });
    expect(findToolImage(turns, 'a', 2)).toMatchObject({ ok: false, code: 'no_such_image' });
    expect(findToolImage(turns, 'a', -1)).toMatchObject({ ok: false, code: 'no_such_image' });
    expect(findToolImage(turns, 'a', 0.5)).toMatchObject({ ok: false, code: 'no_such_image' });
    // 消息条目同 id 也不算:它不是工具。
    expect(findToolImage(turns, 'm1', 0)).toMatchObject({ ok: false, code: 'no_such_item' });
  });

  it('超过上限的一张回 too_large(手机说「在桌面上看」);正好在上限上的照给', () => {
    const big = [{ id: 't1', seq: 1, initiator: 'user', items: [tool('b', { images: [shot('x'.repeat(TOOL_IMAGE_FETCH_LIMIT)), shot('x'.repeat(TOOL_IMAGE_FETCH_LIMIT + 1))] })] }] as unknown as TranscriptTurn[];
    expect(findToolImage(big, 'b', 0)).toMatchObject({ ok: true });
    expect(findToolImage(big, 'b', 1)).toMatchObject({ ok: false, code: 'too_large' });
  });
});
