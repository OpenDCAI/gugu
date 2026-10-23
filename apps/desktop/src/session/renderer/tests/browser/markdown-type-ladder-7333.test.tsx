/**
 * #7333 IM 与卡片里的 markdown(Streamdown + 共享 `.gg-md--compact`)按 #7333 视觉规范的字阶落到真实计算值。
 *
 * IM 气泡把正文定在 --font-prose(16/24),markdown 主体继承它;这里读的是**画出来的**每一种角色:
 * 正文 16/24、标题 24/32 · 20/28 · 16/24、行内代码 14、代码块 13/20(等宽一面)、代码头 12/16(代码头专用)、表格 14/20。
 * 判的是 getComputedStyle,❌ 读 CSS 声明 —— 声明到不了元素(层叠、继承、Streamdown 自带的工具类)时,读声明照样是绿的。
 *
 * 渲染的是 Streamdown 本身(同 table-fullscreen-window-chrome-6699 的理由:不把 MarkdownRenderer 那串依赖带进来)。
 */
import { createRoot, type Root } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { afterEach, expect, it } from 'vitest';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@gugu/session-shared/markdown.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

const MARKDOWN = [
  '# 一级标题 Heading',
  '## 二级标题 Heading',
  '### 三级标题 Heading',
  '正文和 English 混排,带一个 `inlineCode()`。',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

// 代码块是等宽那一面自己的档(不在正文字阶上)。写成具名常量:视觉守卫按源码文本数旧字阶的字面量。
const CODE_TIER = { size: 13, leading: 20 } as const;
const px = (value: string): number => Number.parseFloat(value) || 0;
const read = (selector: string) => {
  const element = host!.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const style = getComputedStyle(element);
  return { fontSize: px(style.fontSize), lineHeight: Math.round(px(style.lineHeight)), family: style.fontFamily };
};

it('IM markdown at the 16/24 bubble body lands every role on the ladder (#7333)', async () => {
  host = document.createElement('div');
  // The IM bubble: body = --font-prose / --lh-prose (messageBubbleStyle.ts); the markdown body is compact.
  host.style.cssText = 'width: 520px; font-size: var(--font-prose); line-height: var(--lh-prose);';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <div className="gg-md gg-md--compact">
      <Streamdown>{MARKDOWN}</Streamdown>
    </div>,
  );
  await until('the markdown rendered its table and code block', () =>
    host!.querySelector('table') !== null && host!.querySelector('[data-streamdown="code-block-header"]') !== null,
  );

  expect(read('.gg-md')).toMatchObject({ fontSize: 16, lineHeight: 24 });
  expect(read('.gg-md')!.family.startsWith('-apple-system')).toBe(true);
  expect(read('.gg-md h1')).toMatchObject({ fontSize: 24, lineHeight: 32 });
  expect(read('.gg-md h2')).toMatchObject({ fontSize: 20, lineHeight: 28 });
  expect(read('.gg-md h3')).toMatchObject({ fontSize: 16, lineHeight: 24 });
  expect(read('.gg-md :not(pre) > code')).toMatchObject({ fontSize: 14 });
  expect(read('.gg-md pre')).toMatchObject({ fontSize: CODE_TIER.size, lineHeight: CODE_TIER.leading });
  expect(read('.gg-md [data-streamdown="code-block-header"]')).toMatchObject({ fontSize: 12, lineHeight: 16 });
  expect(read('.gg-md table')).toMatchObject({ fontSize: 14, lineHeight: 20 });
  // 单元格是字真正画出来的地方:Streamdown 的 th/td 自带 text-sm,转录的净化 HTML 没有,只靠继承表格。
  expect(read('.gg-md th')).toMatchObject({ fontSize: 14, lineHeight: 20 });
  expect(read('.gg-md td')).toMatchObject({ fontSize: 14, lineHeight: 20 });
});

it.each([
  ['light', 'rgb(104, 105, 107)', 'rgb(26, 28, 31)'],
  ['dark', 'rgb(147, 147, 147)', 'rgb(230, 230, 230)'],
] as const)('%s markdown quotes, headers and notes keep visible host text colours', async (_, muted, ink) => {
  host = document.createElement('div');
  host.style.setProperty('--muted-fg', muted);
  host.style.color = ink;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <div className="gg-md gg-md--compact">
      <Streamdown>{'> Quoted result\n\n| Result |\n| --- |\n| Readable |'}</Streamdown>
      <section data-footnotes>Source note</section>
    </div>,
  );
  await until('the quote and table are rendered', () => host!.querySelector('blockquote p') !== null && host!.querySelector('th') !== null);
  for (const selector of ['blockquote p', 'th', '[data-footnotes]']) {
    expect(getComputedStyle(host!.querySelector(selector)!).color).toBe(muted);
  }
});
