import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionView: vi.fn(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      viewParamsStore: {},
    },
  },
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    app: {
      openExternal: vi.fn(),
    },
  },
}));

describe('MarkdownRenderer', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('constrains markdown images in compact rendering', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '![Screenshot](https://example.com/screenshot.png)',
        density: 'compact',
      })
    );

    expect(html).toContain('src="https://example.com/screenshot.png"');
    expect(html).toContain('alt="Screenshot"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('max-w-full');
    expect(html).toContain('max-h-80');
    expect(html).toContain('object-contain');
  });

  it('constrains allowed HTML images in compact rendering', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '<img src="https://example.com/preview.png" alt="Preview">',
        density: 'compact',
      })
    );

    expect(html).toContain('src="https://example.com/preview.png"');
    expect(html).toContain('alt="Preview"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('max-w-full');
    expect(html).toContain('max-h-80');
    expect(html).toContain('object-contain');
  });

  it('renders compact markdown tables with visible structure', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content:
          '| Layer | What | How |\n| --- | --- | --- |\n| Primary | Headline | Display size |',
        density: 'compact',
      })
    );

    expect(html).toContain('<table');
    expect(html).toContain('border-collapse');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('Primary');
  });

  it.each(['comfortable', 'compact'] as const)(
    'selectively ignores only the non-portable display newline warning in %s rendering',
    (density) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const multiline = renderToStaticMarkup(
          React.createElement(MarkdownRenderer, {
            content: ['$$', '\\text{TOPA}=a+b \\\\', '\\text{TOPB}=c+d', '$$'].join('\n'),
            density,
          })
        );
        const multilineWarnings = warn.mock.calls.flat().join('\n');
        expect(multiline).toContain('TOPA');
        expect(multiline).toContain('TOPB');
        expect(multilineWarnings).not.toContain('newLineInDisplayMode');

        warn.mockClear();
        renderToStaticMarkup(
          React.createElement(MarkdownRenderer, {
            content: ['$$', '中文', '$$'].join('\n'),
            density,
          })
        );
        expect(warn.mock.calls.flat().join('\n')).toContain('unicodeTextInMathMode');
      } finally {
        warn.mockRestore();
      }
    }
  );

  it('prevents browser navigation when a link handler claims a relative href', () => {
    const onOpenLink = vi.fn(() => true);

    act(() => {
      root.render(
        React.createElement(MarkdownRenderer, {
          content: '[booking.read](packages/trpc/server/routers/viewer/bookings/get.handler.ts)',
          onOpenLink,
          density: 'comfortable',
        })
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a[href]');
    expect(link).not.toBeNull();

    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link?.dispatchEvent(event);
    });

    expect(onOpenLink).toHaveBeenCalledWith(
      'packages/trpc/server/routers/viewer/bookings/get.handler.ts'
    );
    expect(event.defaultPrevented).toBe(true);
  });
});

/**
 * Streamdown 迁移(替换掉原来 438 行手写 Tailwind 皮肤)带进来的三个静默失效点。
 * 三条都实测复现过,不是设想出来的:
 *  · harden 把相对 URL 就地毁容成 "[blocked]" 文本 —— 会话页 agent 输出几乎全是相对路径链接;
 *  · Streamdown 的 lineNumbers 默认 true —— owner 明确要「没有行号」;
 *  · 样式靠它吐的 Tailwind 工具类,v4 不扫 node_modules,少一行 @source 就整套消失且不报错。
 */
describe('MarkdownRenderer · Streamdown 接线', () => {
  it('相对路径链接仍是可点的 <a>,不是 [blocked] 文本', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '[booking.read](packages/trpc/get.handler.ts)',
        density: 'comfortable',
      })
    );
    expect(html).toContain('href="packages/trpc/get.handler.ts"');
    // ❌ 库默认的 harden 会把它换成 <span>…[blocked]</span>,正文被替换而不是样式问题。
    expect(html).not.toContain('[blocked]');
    expect(html).not.toContain('Blocked URL');
  });

  it('摘掉 harden 没有把净化一起摘掉 —— script 与 javascript: 仍被剥', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '<script>alert(1)</script>正常文字\n\n[点我](javascript:alert(1))',
        density: 'comfortable',
      })
    );
    expect(html).toContain('正常文字');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('javascript:');
  });

  it('代码块不画行号 —— Streamdown 的 lineNumbers 默认是 true', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '```ts\nconst a = 1;\nconst b = 2;\n```',
        density: 'comfortable',
      })
    );
    expect(html).toContain('data-streamdown="code-block"');
    // ⚠️ 判据是**变异验证逼出来的**。第一版查的是 `data-line-number` / `line-numbers`,
    // 那两个字符串在开与关两种输出里都不存在 —— 把 lineNumbers 改回 true 照样绿。
    // Streamdown 画行号用的是 CSS 计数器:<code class="[counter-reset:line]"> 配
    // <span class="before:content-[counter(line)]">。这才是开关真正的形状。
    expect(html).not.toContain('counter-reset:line');
    expect(html).not.toContain('content-[counter(line)]');
  });

  it('文件头的 frontmatter 渲成 yaml 代码块 —— ❌ 不是一个比正文标题还大的 h2', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: [
          '---',
          'name: session-start-never-blocks-on-cloud',
          'metadata:',
          '  pinned: true',
          '---',
          '',
          '# 会话启动不许等云端',
          '',
          '正文第一段。',
        ].join('\n'),
        density: 'comfortable',
        frontmatter: true,
      })
    );

    expect(html).toContain('data-streamdown="code-block"');
    expect(html).toContain('session-start-never-blocks-on-cloud');
    // ⚠️ 判据取的是 bug 的真实形状,不是「有没有代码块」:不接 remark-frontmatter 时,
    // CommonMark 把首行 `---` 读成分隔线、把收尾的 `---` 读成 setext 下划线,于是整段
    // YAML 变成 <h2> 且前面多一条 <hr>。正文的 # 标题在两种情况下都还是 h1,
    // 所以只查「有 h1」「有 code」会照样绿。
    expect(html).not.toContain('<h2');
    expect(html).not.toContain('<hr');
    expect(html).toContain('会话启动不许等云端');
  });

  it('frontmatter 与同内容的 ```yaml 围栏块渲染结果逐字节一致', () => {
    const render = (content: string) =>
      renderToStaticMarkup(
        React.createElement(MarkdownRenderer, { content, density: 'comfortable', frontmatter: true })
      );

    // 这条比「有没有 code-block」硬:它把 frontmatter 钉在**产品已有的那种代码块**上,
    // 将来 Streamdown 换皮、换高亮、换控件,两边一起变,判据不会过期;
    // 而任何让 frontmatter 走上另一条渲染路径的改动都会当场红。
    expect(render(['---', 'name: abc', 'pinned: true', '---'].join('\n'))).toBe(
      render(['```yaml', 'name: abc', 'pinned: true', '```'].join('\n'))
    );
  });

  it('没开 frontmatter 的调用方(PR 评论)里,开头的 `---` 仍按 CommonMark 读成分隔线', () => {
    // 评论是自由文本,不是文件。一条以 `---` 开头、正文里又出现 `---` 的评论,
    // 若按 frontmatter 解析会把中间整段吞进代码块 —— 那是把别人的评论渲毁,不是修好。
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: ['---', '**重点**在这里', '---', '', '后面还有正文'].join('\n'),
        density: 'compact',
      })
    );

    expect(html).toContain('data-streamdown="horizontal-rule"');
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toContain('重点');
    expect(html).not.toContain('data-streamdown="code-block"');
  });
});

const SESSION_INDEX_CSS = path.resolve(__dirname, '../index.css');

/**
 * 从 index.css 里那行 @source **解析**出 Streamdown 产物目录,而不是在测试里另写一份路径。
 * 这样「@source 写了但相对深度错了」也会被照出来 —— 那种情况下样式同样整套消失,
 * 而只查「字符串在不在」的判据会照样绿。
 */
function streamdownDistFromSource(): string {
  const css = readFileSync(SESSION_INDEX_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /@source\s+['"]([^'"]*streamdown\/dist)['"]/.exec(css);
  if (!m) throw new Error('index.css 里没有指向 streamdown/dist 的 @source');
  return path.resolve(path.dirname(SESSION_INDEX_CSS), m[1]);
}

/** index.css 剥掉注释 —— 说明性注释里写着 @source 和色标名,不剥就是拿自己的文档喂判据。 */
function sessionThemeCss(): string {
  return readFileSync(path.resolve(__dirname, '../index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
}

describe('任务页 Tailwind 必须扫到 Streamdown', () => {
  it('index.css 里有指向 streamdown/dist 的 @source', () => {
    // 少了这一行:class 照常输出、样式一条不生成、控制台不报任何错。
    expect(sessionThemeCss()).toMatch(/@source\s+['"][^'"]*streamdown\/dist['"]/);
    // 而且这条路径必须真的指到东西上 —— 相对深度写错时症状与压根没写完全一样。
    expect(existsSync(streamdownDistFromSource())).toBe(true);
  });

  /**
   * Streamdown 吐什么色标,会话页的 @theme 就得登记什么 —— Tailwind v4 对没登记的
   * color key **静默丢掉整条 utility**,不报错(#2374)。
   *
   * 真栽过:`sidebar`(代码块容器与操作条,dist 里 9 处)当时没登记 ⇒ 代码块既没有底色
   * 也没有边框色,四门全绿。所以这条不写死某个 key 的清单,而是**从库的产物里抠**:
   * 将来升级 Streamdown 引入新色标,这里会先红,而不是在界面上悄悄透明。
   */
  it('Streamdown 用到的 shadcn 语义色,任务页 @theme 都登记了', () => {
    // 读整个 dist,别钉某个带哈希的 chunk 名(升版就变)。
    const dir = streamdownDistFromSource();
    const dist = readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');

    const used = new Set<string>();
    const re =
      /\b(?:bg|text|border|ring|divide|from|to|fill|stroke)-([a-z]+(?:-[a-z]+)*)(?:\/\d+)?\b/g;
    for (const m of dist.matchAll(re)) used.add(m[1]);

    // shadcn 的语义色词表 —— 用它把 `text-base` / `border-l` 这类非颜色词滤掉。
    // ❌ 不拿主 app 的 @theme 当参照:实测它自己就缺 `sidebar`(Streamdown 的代码块
    //   容器与操作条那 9 处 `bg-sidebar` / `border-sidebar` 在主 app 里同样被静默丢掉),
    //   拿一个自己有洞的表当判据,洞会原样复制过来。
    const SHADCN = /^(background|foreground|muted|border|primary|secondary|accent|card|popover|destructive|input|ring|sidebar)(-foreground)?$/;
    const needed = [...used].filter((k) => SHADCN.test(k));
    const sessionTheme = sessionThemeCss();
    const missing = needed.filter((k) => !sessionTheme.includes(`--color-${k}:`));

    // 阳性对照:抠取正则失效时 needed 会空 —— 那样 missing 恒为空,这条就成了空话。
    expect(needed.length).toBeGreaterThan(3);
    expect(
      missing,
      `任务页 @theme 缺这些色标 → 对应 utility 会静默消失(#2374): ${missing.join(', ')}`
    ).toEqual([]);
  });
});
