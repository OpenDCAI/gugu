/**
 * 148 10-14(旁观的活画面,②):工具交回来的图留在转录里。
 *
 * MCP 工具的结果块就是 ACP 的块:两个桥都把图交成 `content` 里的 `{ type: 'content', content: { type: 'image' } }`
 * (mac1 第 0 步实抓:Claude 桥 4 张图 + 每张一句 `[Image: source: …]`;Codex 桥自 ① 起同样交)。解码以前只留文字,
 * 图被丢掉,卡上只剩那句 `[Image: …]`。这里按实抓的形状喂原始 ACP 更新,看条目上留没留下图。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import type { ToolCallItem } from '../models/turns';
import { AcpTranscriptParser } from './parser';

const JPEG_A = { mimeType: 'image/jpeg', data: '/9j/AAAA' };
const JPEG_B = { mimeType: 'image/jpeg', data: '/9j/BBBB' };
const image = (one: { mimeType: string; data: string }) => ({ type: 'content', content: { type: 'image', ...one } });
const text = (value: string) => ({ type: 'content', content: { type: 'text', text: value } });

function itemAfter(updates: object[]): ToolCallItem {
  const parser = new AcpTranscriptParser({ sessionId: 's' });
  parser.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'check it' } } as never, 1);
  updates.forEach((update, i) => parser.push(update as SessionUpdate, 2 + i));
  const item = parser.activeTurn?.items.find((one) => 'toolCallId' in one && one.toolCallId === 'call-1');
  if (!item) throw new Error('no tool item');
  return item as ToolCallItem;
}

const started = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'mcp__plugin_gugu-product_gugu__catalog_call',
  kind: 'other',
  status: 'pending',
  rawInput: {},
};

describe('工具交回来的图留在转录条目上(148 10-14)', () => {
  it('Claude 桥的形状:图按原样、按顺序留下,那句 [Image: …] 照旧是文字', () => {
    const item = itemAfter([
      started,
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [image(JPEG_A), text('[Image: source: /tmp/a.jpg]'), image(JPEG_B), text('[Image: source: /tmp/b.jpg]')],
      },
    ]);
    expect(item.images).toEqual([JPEG_A, JPEG_B]);
    expect(item.outputText).toBe('[Image: source: /tmp/a.jpg]\n[Image: source: /tmp/b.jpg]');
  });

  it('Codex 桥的形状(① 之后):content 里有图,rawOutput 照旧是 provider 原样', () => {
    const item = itemAfter([
      started,
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [text('It loaded without errors.'), image(JPEG_A)],
        rawOutput: { content: [{ type: 'text', text: 'It loaded without errors.' }, { type: 'image', ...JPEG_A }] },
      },
    ]);
    expect(item.images).toEqual([JPEG_A]);
    expect(item.outputText).toBe('It loaded without errors.');
  });

  it('后来的更新不带 content = 图保持不变;带了新图 = 换成新的', () => {
    const done = { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [image(JPEG_A)] };
    expect(itemAfter([started, done, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'renamed' }]).images).toEqual([JPEG_A]);
    expect(itemAfter([started, done, { ...done, content: [image(JPEG_B)] }]).images).toEqual([JPEG_B]);
  });

  it('只认真图:没有数据的、mimeType 不是图的、不是 image 块的都不收', () => {
    const item = itemAfter([
      started,
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [
          image({ mimeType: 'image/png', data: '' }),
          image({ mimeType: 'text/html', data: 'PGI+' }),
          { type: 'content', content: { type: 'resource_link', uri: 'file:///a.png', name: 'a.png' } },
          image(JPEG_B),
        ],
      },
    ]);
    expect(item.images).toEqual([JPEG_B]);
  });

  it('阴控:只回文字的工具,条目上没有 images 这一格', () => {
    const item = itemAfter([
      started,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [text('ok')] },
    ]);
    expect(item.outputText).toBe('ok');
    expect(item).not.toHaveProperty('images');
  });

  it('图先于创建到达(更新先到)也留下', () => {
    const item = itemAfter([
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: started.title, status: 'completed', content: [image(JPEG_A)] },
    ]);
    expect(item.images).toEqual([JPEG_A]);
  });
});
