import { decodeSessionUpdate } from '@gugu/session-core/acp';
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
import { projectToolContent, payloadWithoutImages, withoutToolImages } from '../models/tool-payload';
import { AcpTranscriptParser } from './parser';

const JPEG_A = { mimeType: 'image/jpeg', data: '/9j/AAAA' };
const JPEG_B = { mimeType: 'image/jpeg', data: '/9j/BBBB' };
const image = (one: { mimeType: string; data: string }) => ({ type: 'content', content: { type: 'image', ...one } });
const text = (value: string) => ({ type: 'content', content: { type: 'text', text: value } });

function itemAfter(updates: object[]): ToolCallItem {
  const parser = new AcpTranscriptParser({ sessionId: 's' });
  parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'check it' } } as never), 1);
  updates.forEach((update, i) => parser.pushEvent(decodeSessionUpdate(update as SessionUpdate), 2 + i));
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

/**
 * #980: one picture, one copy. A screenshot Read used to keep the same base64 in the content blocks, in `images` and
 * inside the provider's `rawOutput` — three copies in every stored turn (measured on a real session: 2.4 MB of
 * pictures stored as 7.2 MB). The shapes below are the ones the Claude and Codex bridges send.
 */
describe('a tool picture is stored once (#980)', () => {
  const PNG = { mimeType: 'image/png', data: `iVBORw0KGgo${'A'.repeat(4096)}` };
  const PNG_2 = { mimeType: 'image/png', data: `iVBORw0KGgo${'B'.repeat(4096)}` };
  const readStarted = {
    sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read /tmp/shot.png', kind: 'read', status: 'pending',
    rawInput: { file_path: '/tmp/shot.png' }, locations: [{ path: '/tmp/shot.png' }],
  };
  /** Claude's tool result, as its bridge forwards it in `rawOutput`. */
  const claudeRaw = (one: { mimeType: string; data: string }) =>
    [{ type: 'image', source: { type: 'base64', data: one.data, media_type: one.mimeType } }];
  const copies = (value: unknown, data: string) => JSON.stringify(value).split(data).length - 1;

  it('Claude Read of a PNG: images keep the picture, the blocks and rawOutput no longer carry it', () => {
    const item = itemAfter([
      readStarted,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [image(PNG)], rawOutput: claudeRaw(PNG) },
    ]);
    expect(item.kind).toBe('read-tool-call');
    expect(item.images).toEqual([PNG]);
    expect(copies(item, PNG.data)).toBe(1);
    expect(item.contentBlocks).toEqual([]);
    // The read row shows rawOutput as its result: still the provider's JSON, with a note where the base64 was.
    expect(JSON.parse(item.rawOutput!)).toEqual([
      { type: 'image', source: { type: 'base64', data: '[image 1: 4107 base64 chars]', media_type: 'image/png' } },
    ]);
  });

  it('Codex shape: the text beside the picture stays in the blocks and in rawOutput', () => {
    const item = itemAfter([
      started,
      {
        sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
        content: [text('It loaded.'), image(PNG)],
        rawOutput: { content: [{ type: 'text', text: 'It loaded.' }, { type: 'image', ...PNG }] },
      },
    ]);
    expect(item.images).toEqual([PNG]);
    expect(item.outputText).toBe('It loaded.');
    expect(item.contentBlocks).toEqual([text('It loaded.')]);
    expect(copies(item, PNG.data)).toBe(1);
    expect(JSON.parse(item.rawOutput!)).toEqual({
      content: [{ type: 'text', text: 'It loaded.' }, { type: 'image', mimeType: 'image/png', data: '[image 1: 4107 base64 chars]' }],
    });
  });

  it('rawOutput and the picture may come in either order, in separate updates', () => {
    const rawFirst = itemAfter([
      readStarted,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', rawOutput: claudeRaw(PNG) },
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [image(PNG)] },
    ]);
    const pictureFirst = itemAfter([
      readStarted,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [image(PNG)] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', rawOutput: claudeRaw(PNG) },
    ]);
    for (const item of [rawFirst, pictureFirst]) {
      expect(item.images).toEqual([PNG]);
      expect(copies(item, PNG.data)).toBe(1);
    }
  });

  it('a chunk appended after the picture keeps it; a new picture joins it', () => {
    const appended = itemAfter([
      started,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [image(PNG)] },
      { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'call-1', content: text('caption') },
      { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'call-1', content: image(PNG_2) },
    ]);
    expect(appended.images).toEqual([PNG, PNG_2]);
    expect(appended.outputText).toBe('caption');
    expect(copies(appended, PNG.data) + copies(appended, PNG_2.data)).toBe(2);
    // Replacing the content still drops the pictures, as before.
    const cleared = itemAfter([
      started,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [image(PNG)] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [text('gone')] },
    ]);
    expect(cleared).not.toHaveProperty('images');
    expect(cleared.outputText).toBe('gone');
  });

  it('a stored item folded before #980 (picture still in its blocks) appends without doubling it', () => {
    const parser = new AcpTranscriptParser({ sessionId: 's' });
    parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } } as never), 1);
    parser.pushEvent(decodeSessionUpdate(started as SessionUpdate), 2);
    const state = structuredClone(parser.snapshotState());
    const legacy = state.transcript.active!.items.find((one) => 'toolCallId' in one) as ToolCallItem;
    Object.assign(legacy, { images: [PNG], contentBlocks: [image(PNG)] });
    const restored = new AcpTranscriptParser({ sessionId: 's' });
    restored.restoreState(state);
    restored.pushEvent(decodeSessionUpdate({ sessionUpdate: 'tool_call_content_chunk', toolCallId: 'call-1', content: text('more') } as never), 3);
    const item = restored.activeTurn?.items.find((one) => 'toolCallId' in one) as ToolCallItem;
    expect(item.images).toEqual([PNG]);
    expect(item.outputText).toBe('more');
    expect(copies(item, PNG.data)).toBe(1);
  });

  it('a whole turn of grouped reads carries each screenshot once', () => {
    const parser = new AcpTranscriptParser({ sessionId: 's' });
    parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'look' } } as never), 1);
    [PNG, PNG_2].forEach((one, i) => {
      const toolCallId = `read-${i}`;
      parser.pushEvent(decodeSessionUpdate({ ...readStarted, toolCallId } as SessionUpdate), 10 + i * 2);
      parser.pushEvent(decodeSessionUpdate({
        sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', content: [image(one)], rawOutput: claudeRaw(one),
      } as SessionUpdate), 11 + i * 2);
    });
    parser.endTurn(20);
    const turn = parser.history[0];
    expect(turn.items.find((one) => one.kind === 'tool-group')).toMatchObject({ groupKind: 'read-batch' });
    expect(copies(turn, PNG.data)).toBe(1);
    expect(copies(turn, PNG_2.data)).toBe(1);
  });

  it('negative controls: a differently encoded copy, a substring and a text-only result are left as they came', () => {
    const reencoded = itemAfter([
      readStarted,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [image(PNG)], rawOutput: claudeRaw(PNG_2) },
    ]);
    expect(JSON.parse(reencoded.rawOutput!)).toEqual(claudeRaw(PNG_2));
    const inText = itemAfter([
      readStarted,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [image(PNG)], rawOutput: { note: `x${PNG.data}x` } },
    ]);
    expect(JSON.parse(inText.rawOutput!)).toEqual({ note: `x${PNG.data}x` });
    const textOnly = itemAfter([
      started,
      { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', content: [text('ok')], rawOutput: { data: 'ok' } },
    ]);
    expect(JSON.parse(textOnly.rawOutput!)).toEqual({ data: 'ok' });
    expect(textOnly.contentBlocks).toEqual([text('ok')]);
  });
});

describe('withoutToolImages / payloadWithoutImages', () => {
  it('drops only the picture blocks the projection reads; diff, terminal, text and non-pictures stay', () => {
    const diff = { type: 'diff', changes: [{ operation: 'delete', path: '/a' }], scope: 'unknown' };
    const terminal = { type: 'terminal', terminalId: 't' };
    const notPicture = image({ mimeType: 'text/html', data: 'PGI+' });
    const blocks = [text('a'), image(JPEG_A), diff, terminal, notPicture, { type: 'image', mimeType: 'image/png', data: 'cGc=' }];
    expect(withoutToolImages(blocks)).toEqual([text('a'), diff, terminal, notPicture]);
    expect(projectToolContent(blocks).images).toHaveLength(2);
  });

  it('keeps the JSON valid and replaces every whole occurrence of a picture', () => {
    const raw = JSON.stringify({ a: JPEG_A.data, b: [JPEG_A.data], c: JPEG_B.data }, null, 2);
    expect(JSON.parse(payloadWithoutImages(raw, [JPEG_A, JPEG_B]))).toEqual({
      a: '[image 1: 8 base64 chars]', b: ['[image 1: 8 base64 chars]'], c: '[image 2: 8 base64 chars]',
    });
  });
});
