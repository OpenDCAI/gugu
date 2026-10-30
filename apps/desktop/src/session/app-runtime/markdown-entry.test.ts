// @vitest-environment jsdom
// gugu.markdown() (markdown-entry.ts): the host's markdown rendering on an App page. Judged here: it is the shared
// dialect (structure, math, tables, tasks, footnotes, heading anchors); others' words never become markup; links go
// out only the ways an App page has; a re-render keeps its root; an image naming a file is read once through the page's
// own gugu.files and drawn in its chip. The stylesheet and the browser's layout are judged on the product (mac1 A/B), not here.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderer } from './markdown-entry';

const gugu = {
  openLink: vi.fn(async (_url: string) => undefined),
  reportError: vi.fn(async (_message: string) => undefined),
  openBrowserTab: vi.fn(async (_url: string) => undefined),
  files: {
    openWith: vi.fn(async (_file: unknown, _options?: unknown) => undefined),
    open: vi.fn(async (_file: unknown): Promise<unknown> => undefined),
    readVersion: vi.fn(async (_file: unknown, _n: number): Promise<unknown> => undefined),
    onChanged: vi.fn((_place: unknown, _handler: (change: { kind: string; entries?: { id: string; version?: number | null }[]; gone?: string[] }) => void) => () => undefined),
  },
};
const render = renderer(gugu);

function rendered(text: string, options?: unknown): HTMLElement {
  const box = document.createElement('article');
  document.body.append(box);
  render(box, text, options);
  return box;
}

const click = (element: Element | null) => {
  if (!element) throw new Error('nothing to click');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
};

beforeAll(() => {
  // jsdom has neither: the anchor lookup escapes ids and scrolls the target into view.
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (value: string) => value.replace(/["\\]/g, '\\$&') };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('gugu.markdown(): the shared dialect', () => {
  it('structure, math, tables with their alignment, task items, footnotes and heading anchors', () => {
    const box = rendered(
      [
        '# 标题 *一*',
        '',
        '一段 **粗** 和 `code`、~~删掉~~，行内 $E = mc^2$，还有 $a\\,b$。[^1]',
        '',
        '3. 三',
        '4. 四',
        '',
        '- [x] 做完了',
        '- [ ] 还没做',
        '',
        '| L | C | R |',
        '| :--- | :---: | ---: |',
        '| 1 | 2 | 3 |',
        '',
        '$$',
        '\\int_0^1 x^2\\,dx',
        '$$',
        '',
        '```ts',
        'const a = 1',
        '```',
        '',
        '[^1]: 脚注。',
      ].join('\n'),
      { density: 'comfortable' }
    );
    const root = box.firstElementChild as HTMLElement;
    expect(box.children).toHaveLength(1);
    expect(root.className).toBe('gg-md gg-md--comfortable');
    expect(root.querySelector('h1')?.textContent).toBe('标题 一');
    expect(root.querySelector('h1')?.id, 'GitHub anchor ids, clobber-prefixed').toBe('user-content-标题-一');
    expect(root.querySelector('strong')?.textContent).toBe('粗');
    expect(root.querySelector('del')?.textContent).toBe('删掉');
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[true, true], [false, true]]);
    expect([...root.querySelectorAll('tbody td')].map((td) => td.getAttribute('align'))).toEqual(['left', 'center', 'right']);
    expect(root.querySelector('.gg-md-table-scroll > table'), 'a wide table scrolls in its own box').not.toBeNull();
    expect(root.querySelectorAll('.katex').length, 'two inline formulas and one display').toBe(3);
    expect(root.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(root.textContent, 'formula source is typeset, not shown').not.toContain('mc^2$');
    expect(root.querySelector('section[data-footnotes] li')?.textContent).toContain('脚注');
    expect(root.querySelector('pre > code.language-ts')?.textContent).toBe('const a = 1\n');
  });

  it('frontmatter is a yaml code block only when asked (a file), never a setext heading', () => {
    const text = '---\ntitle: x\n---\n\n正文';
    expect(rendered(text, { frontmatter: true }).querySelector('pre > code.language-yaml')?.textContent).toContain('title: x');
    expect(rendered(text).querySelector('code.language-yaml')).toBeNull();
  });

  it('code is coloured with the transcript highlighter: one span per token, carrying the dual-theme vars', async () => {
    const box = rendered('```ts\nexport function greet(name: string) {\n  return name\n}\n```');
    await vi.waitFor(() => expect(box.querySelectorAll('pre code span[style*="--shiki-light"]').length).toBeGreaterThan(3));
    expect(box.querySelector('pre code')?.textContent).toBe('export function greet(name: string) {\n  return name\n}\n');
  });
});

describe('gugu.markdown(): others\' words never become markup', () => {
  const hostile = [
    '<img src=x onerror="window.__pwned = 1">',
    '',
    'inline <b onclick="x()">tag</b> and <details><summary>s</summary>d</details>',
    '',
    '[bad](javascript:alert(1)) [ok](https://gugu.example/a) [mail](mailto:a@b.c)',
    '',
    '![alt 文本](https://example.com/p.png)',
    '',
    'escape \\*not em\\* &amp; &#x4e2d;',
  ].join('\n');

  it('chat (the default): raw HTML is text; an image is a link chip that loads nothing', () => {
    const box = rendered(hostile);
    expect(box.querySelectorAll('img, b, details, script, [onerror], [onclick]')).toHaveLength(0);
    expect(box.textContent).toContain('<img src=x onerror="window.__pwned = 1">');
    expect(box.textContent).toContain('<details><summary>s</summary>d</details>');
    const links = [...box.querySelectorAll('a:not(.gg-md-image)')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['bad', null], ['ok', 'https://gugu.example/a'], ['mail', 'mailto:a@b.c']]);
    const chip = box.querySelector('a.gg-md-image');
    expect([chip?.textContent, chip?.getAttribute('href')]).toEqual(['alt 文本', 'https://example.com/p.png']);
    expect(box.textContent).toContain('escape *not em* & 中');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('document: raw HTML is parsed and then sanitized — details stays, handlers and scripts go, images are still chips', () => {
    const box = rendered(`${hostile}\n\n<script>window.__pwned = 2</script>`, { trust: 'document' });
    expect(box.querySelector('details > summary')?.textContent).toBe('s');
    expect(box.querySelectorAll('img, script, [onerror], [onclick]')).toHaveLength(0);
    expect([...box.querySelectorAll('a.gg-md-image')].map((a) => a.getAttribute('href'))).toContain('https://example.com/p.png');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('gugu.markdown(): links, the ways an App page has out', () => {
  // A chat file as the host hands it: `name` its name alone, `path` from the top of the folder.
  const file = { chat: 'chat-1', id: 'i-1', name: 'plan.md', path: 'notes/plan.md' };
  const box = () =>
    rendered(
      [
        '## 安装 步骤',
        '',
        '[跳](#安装-步骤) [网](https://example.com/x) [群文件](gugu-file://0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60)',
        '[第5页](gugu-file://0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60?v=3#page=5)',
        '[旁边](./todo.md) [上一层](../readme.md#top) [邮件](mailto:a@b.c) [坏](javascript:alert(1))',
      ].join('\n'),
      { file }
    );
  const link = (root: HTMLElement, text: string) => [...root.querySelectorAll('a')].find((a) => a.textContent === text) ?? null;

  it('#anchor scrolls to its heading here; http(s) opens a browser tab; nothing navigates the page', () => {
    const root = box();
    const heading = root.querySelector('h2')!;
    const scrolled = vi.spyOn(heading, 'scrollIntoView');
    expect(click(link(root, '跳')).defaultPrevented).toBe(true);
    expect(scrolled).toHaveBeenCalledOnce();
    expect(click(link(root, '网')).defaultPrevented).toBe(true);
    expect(gugu.openBrowserTab).toHaveBeenCalledWith('https://example.com/x');
  });

  it('a resource link uses openLink; relative files still open beside this file', () => {
    const root = box();
    click(link(root, '群文件'));
    click(link(root, '旁边'));
    click(link(root, '上一层'));
    expect(gugu.openLink).toHaveBeenCalledExactlyOnceWith('gugu-file://0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60');
    expect(gugu.files.openWith.mock.calls.map(([target]) => target)).toEqual([
      { chat: 'chat-1', name: 'notes/todo.md' },
      { chat: 'chat-1', name: 'readme.md' },
    ]);
  });

  // 读论文车道 10-19: a pill in a handout opened the paper on page 1 — the place in its link was dropped here, while the
  // same pill in the chat opened at its page (`openGroupFile`).
  it('a pill: the place its link points at goes with the file (as a pill in the chat opens it); a plain link has none', () => {
    const root = box();
    click(link(root, '第5页'));
    click(link(root, '群文件'));
    expect(gugu.openLink.mock.calls).toEqual([
      ['gugu-file://0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60?v=3#page=5'],
      ['gugu-file://0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f60'],
    ]);
    expect(gugu.files.openWith).not.toHaveBeenCalled();
  });

  it('chat, App and external resource URIs each use the one host verb once', () => {
    const links = ['gugu-chat://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'gugu-beta://ext/chess/main/game/7', 'gugu-dev://project/p1'];
    const root = rendered(links.map((href, index) => `[resource${index}](${href})`).join(' '));
    for (const anchor of root.querySelectorAll('a')) click(anchor);
    expect(gugu.openLink.mock.calls).toEqual(links.map((href) => [href]));
    expect(gugu.files.openWith).not.toHaveBeenCalled();
    expect(gugu.openBrowserTab).not.toHaveBeenCalled();
  });

  it('reports the host refusal instead of swallowing a failed click', async () => {
    gugu.openLink.mockRejectedValueOnce(new Error('This file is unavailable'));
    click(link(box(), '群文件'));
    await Promise.resolve();
    expect(gugu.reportError).toHaveBeenCalledExactlyOnceWith('This file is unavailable');
  });

  it('mailto and a stripped javascript: link do nothing (an App page has no other way out)', () => {
    const root = box();
    expect(click(link(root, '邮件')).defaultPrevented).toBe(true);
    click(link(root, '坏'));
    expect(gugu.openBrowserTab).not.toHaveBeenCalled();
    expect(gugu.files.openWith).not.toHaveBeenCalled();
  });

  it('without a file, a relative link opens nothing', () => {
    const root = rendered('[旁边](./todo.md)');
    click(root.querySelector('a'));
    expect(gugu.files.openWith).not.toHaveBeenCalled();
  });
});

describe('gugu.markdown(): an image naming a file is drawn in its chip, read through gugu.files', () => {
  const PICTURE = '0b6d3a52-5a3e-4b70-9f0e-1d2c3b4a5f61';
  const doc = (chat: string) => ({ chat, id: 'd-1', name: 'readme.md', path: 'docs/readme.md' });
  const stored = (id: string, chat: string, version = 1, contentType = 'image/png') => ({
    type: 'binary', entry: { id, chat, version, contentType }, blob: async () => new Blob(['png'], { type: contentType }), close: vi.fn(),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  let made = 0;

  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => `blob:page/${++made}`);
    URL.revokeObjectURL = vi.fn();
  });

  it('beside the document (from its folder) or by its link: read once however often it renders, a link to it opens the same file', async () => {
    const picture = async (ref: unknown) => stored((ref as { id?: string }).id ?? 'p-1', 'chat-a');
    gugu.files.open.mockImplementationOnce(picture).mockImplementationOnce(picture);
    const box = document.createElement('article');
    document.body.append(box);
    const render = renderer(gugu);
    const text = `![图](p.png) ![链](gugu-file://${PICTURE})\n\n[文](p.png)`;
    render(box, text, { file: doc('chat-a') });
    expect([...box.querySelectorAll('a.gg-md-image')].map((a) => a.getAttribute('data-gg-image'))).toEqual(['loading', 'loading']);
    await settle();
    render(box, `${text} `, { file: doc('chat-a') });
    render(box, text, { file: doc('chat-a') });
    expect(gugu.files.open.mock.calls).toEqual([[{ chat: 'chat-a', name: 'docs/p.png' }], [{ id: PICTURE }]]);
    expect([...box.querySelectorAll('a.gg-md-image > img.gg-md-img')].map((img) => img.getAttribute('alt'))).toEqual(['图', '链']);
    click([...box.querySelectorAll('a')].find((a) => a.textContent === '文')!);
    expect(gugu.files.openWith).toHaveBeenCalledExactlyOnceWith({ chat: 'chat-a', name: 'docs/p.png' });
  });

  it("one it cannot read says the host's reason in its chip, no broken picture; the reading again comes with another document", async () => {
    gugu.files.open.mockRejectedValueOnce(new Error('Studio is offline. This file opens when it is back online.'));
    const box = document.createElement('article');
    document.body.append(box);
    const render = renderer(gugu);
    render(box, '![diagram](offline.png)', { file: doc('chat-b') });
    await settle();
    const chip = box.querySelector('a.gg-md-image')!;
    expect([chip.getAttribute('data-gg-image'), chip.textContent]).toEqual(['failed', 'diagram — Studio is offline. This file opens when it is back online.']);
    expect(box.querySelector('img')).toBeNull();
    render(box, '![diagram](offline.png) ', { file: doc('chat-b') });
    expect(gugu.files.open).toHaveBeenCalledOnce();
    gugu.files.open.mockResolvedValueOnce(stored('o-1', 'chat-b'));
    render(box, '![diagram](offline.png)', { file: { ...doc('chat-b'), id: 'd-2' } });
    await settle();
    expect(gugu.files.open).toHaveBeenCalledTimes(2);
    expect(box.querySelector('img.gg-md-img')).not.toBeNull();
  });

  it('a web picture, a path above the folder and a file that is no picture stay the chips they were, nothing read for the first two', async () => {
    const text = stored('t-1', 'chat-c', 1, 'text/markdown');
    gugu.files.open.mockResolvedValueOnce(text);
    const box = rendered('![w](https://example.com/w.png) ![up](../../x.png) ![t](notes.md)', { file: doc('chat-c') });
    await settle();
    expect(gugu.files.open.mock.calls).toEqual([[{ chat: 'chat-c', name: 'docs/notes.md' }]]);
    expect(text.close).toHaveBeenCalledOnce();
    expect(box.querySelectorAll('img')).toHaveLength(0);
    expect([...box.querySelectorAll('a.gg-md-image')].map((a) => a.hasAttribute('data-gg-image'))).toEqual([false, false, false]);
  });

  it('a kept version (?v=) is read as that version', async () => {
    gugu.files.readVersion.mockResolvedValueOnce(new Blob(['png'], { type: 'image/png' }));
    const box = rendered(`![v3](gugu-file://${PICTURE}?v=3)`, { file: doc('chat-d') });
    await settle();
    expect(gugu.files.readVersion).toHaveBeenCalledExactlyOnceWith({ id: PICTURE }, 3);
    expect(gugu.files.open).not.toHaveBeenCalled();
    expect(box.querySelector('img.gg-md-img')).not.toBeNull();
  });

  it("a new version of the picture's file, heard from its chat, is drawn where the document is open", async () => {
    gugu.files.open.mockResolvedValueOnce(stored('n-1', 'chat-e', 1)).mockResolvedValueOnce(stored('n-1', 'chat-e', 2));
    const box = rendered('![n](live.png)', { file: doc('chat-e') });
    await settle();
    const first = box.querySelector('img')!.getAttribute('src');
    expect(gugu.files.onChanged).toHaveBeenCalledOnce();
    const [place, hear] = gugu.files.onChanged.mock.calls[0]!;
    expect(place).toEqual({ chat: 'chat-e' });
    hear({ kind: 'entries', entries: [{ id: 'other', version: 9 }, { id: 'n-1', version: 1 }], gone: [] });
    expect(gugu.files.open).toHaveBeenCalledOnce();
    hear({ kind: 'entries', entries: [{ id: 'n-1', version: 2 }], gone: [] });
    await settle();
    expect(gugu.files.open).toHaveBeenCalledTimes(2);
    expect(box.querySelector('img')!.getAttribute('src')).not.toBe(first);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
  });
});

// #7238: a page that finds a line's block (the 群文件夹 App: a pill's lines; a selection's lines in the preview).
describe('gugu.markdown(): sourceLines — each block says the lines of the given text it was written on', () => {
  it('top-level blocks carry data-line; a one-line $$…$$ (set as three) shifts nothing after it; asked for only', () => {
    const text = ['# 标题', '', '第一段', '第一段第二行', '', '$$x^2$$', '', '- a', '- b', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '末段'].join('\n');
    const box = rendered(text, { sourceLines: true });
    const lines = (element: Element | null | undefined) => element?.getAttribute('data-line');
    expect(lines(box.querySelector('h1'))).toBe('1-1');
    expect(lines(box.querySelector('p'))).toBe('3-4');
    expect(lines(box.querySelector('ul'))).toBe('8-9');
    // The blocks a line is picked in, inside a block: each list item, each table row.
    expect([...box.querySelectorAll('li')].map(lines)).toEqual(['8-8', '9-9']);
    expect(lines(box.querySelector('table'))).toBe('11-13');
    expect([...box.querySelectorAll('tr')].map(lines)).toEqual(['11-11', '13-13']);
    expect(lines([...box.querySelectorAll('p')].at(-1))).toBe('15-15');
    // Control: without the option no block says its lines.
    expect(rendered(text).querySelector('[data-line]')).toBeNull();
  });

  it('display math says its lines too — one-line $$…$$, \\[…\\], two in a row, a block — found from inside the formula', () => {
    const text = ['$$z^2$$', '', '\\[w+1\\]', '', '$$a$$', '$$b$$', '', '$$', 'c=d', '$$', '', '末段'].join('\n');
    const box = rendered(text, { sourceLines: true });
    // As a page looks a picked word's lines up: the closest block that says them.
    const formulas = [...box.querySelectorAll('.katex-display')];
    expect(formulas.map((f) => f.querySelector('.katex')?.closest('[data-line]')?.getAttribute('data-line'))).toEqual(['1-1', '3-3', '5-5', '6-6', '8-10']);
    expect([...box.querySelectorAll('p')].at(-1)?.getAttribute('data-line')).toBe('12-12');
  });
});

describe('gugu.markdown(): render', () => {
  it('a re-render replaces the content and keeps the same root, so a scrolling element keeps its place', () => {
    const box = rendered('# one');
    const root = box.firstElementChild;
    render(box, '# two', { density: 'compact' });
    expect(box.firstElementChild).toBe(root);
    expect([...box.querySelectorAll('h1')].map((h) => h.textContent)).toEqual(['two']);
    expect(root?.className).toBe('gg-md gg-md--compact');
  });

  it('says what is wrong with a call, coded invalid', () => {
    const calls = [
      () => render('#preview', 'x'),
      () => render(document.createElement('div'), 42),
      () => render(document.createElement('div'), 'x', { trust: 'raw' }),
      () => render(document.createElement('div'), 'x', { density: 'huge' }),
    ];
    for (const call of calls) {
      let thrown: unknown = null;
      try {
        call();
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string } | null)?.code).toBe('invalid');
    }
  });
});
