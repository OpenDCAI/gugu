import { describe, expect, it } from 'vitest';
import { joinPromptText, promptInputItems } from './codex-app-server-prompt.mjs';

/**
 * 这一格的判据:ACP 的 prompt 块进来,codex app-server 的 input items 出去。
 * 正主是「图片块必须留下来」—— 从前它在这里被静默丢掉,表现是输入框上有附件、模型说看不到图。
 */
describe('codex app-server: prompt 块 → input items', () => {
  const image = { type: 'image', data: 'QUJD', mimeType: 'image/png' };

  it('纯文本:相邻文本合成一条,连接方式与从前一致', () => {
    expect(
      promptInputItems([
        { type: 'text', text: '会话上下文' },
        { type: 'text', text: '正文' },
      ])
    ).toEqual([{ type: 'text', text: '会话上下文\n正文', text_elements: [] }]);
  });

  // owner 2026-09-09 撞到的那一格的最小形状:一张图 + 一句话。
  it('图片块变成 app-server 的 image item,data URL 里带的是真字节', () => {
    expect(promptInputItems([image, { type: 'text', text: '图上写的是什么' }])).toEqual([
      { type: 'image', url: 'data:image/png;base64,QUJD' },
      { type: 'text', text: '图上写的是什么', text_elements: [] },
    ]);
  });

  it('只有图片、没有文字时不再退化成一条空文本', () => {
    expect(promptInputItems([image])).toEqual([{ type: 'image', url: 'data:image/png;base64,QUJD' }]);
  });

  // 顺序是调用方定的(斜杠命令必须是第一块)——这里 ❌ 不重排。
  it('命令在最前时,文本仍排在图片前面', () => {
    expect(promptInputItems([{ type: 'text', text: '/review' }, image])).toEqual([
      { type: 'text', text: '/review', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
    ]);
  });

  it('图片块只带 uri 时用那个 uri', () => {
    expect(promptInputItems([{ type: 'image', uri: 'https://example.com/a.png' }])).toEqual([
      { type: 'image', url: 'https://example.com/a.png' },
    ]);
  });

  // 反向对照:非图片的带 uri 块(resource_link)照旧走文本这条路,❌ 不要顺手变成图片。
  it('resource_link 仍按 uri 走文本', () => {
    expect(promptInputItems([{ type: 'resource_link', uri: 'file:///tmp/a.md' }])).toEqual([
      { type: 'text', text: 'file:///tmp/a.md', text_elements: [] },
    ]);
  });

  it('joinPromptText 供重放复用,连接方式与发送侧同一份', () => {
    expect(joinPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });
});
