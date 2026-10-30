import type { Nodes, Root } from 'mdast';
import rehypeSanitize from 'rehype-sanitize';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { describe, expect, it } from 'vitest';
import {
  githubSlug,
  MARKDOWN_SANITIZE_SCHEMA,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownSource,
  parseMarkdown,
  type MarkdownDialectOptions,
} from './dialect';

function run(text: string, options: MarkdownDialectOptions): Root {
  const processor = unified().use(remarkParse).use(markdownRemarkPlugins(options));
  return processor.runSync(processor.parse(text)) as Root;
}

function collect(tree: Nodes, type: string): Nodes[] {
  const out: Nodes[] = tree.type === type ? [tree] : [];
  if ('children' in tree) for (const child of tree.children) out.push(...collect(child as Nodes, type));
  return out;
}

const textOf = (node: Nodes): string =>
  'value' in node && typeof node.value === 'string'
    ? node.value
    : 'children' in node
      ? node.children.map((c) => textOf(c as Nodes)).join('')
      : '';

describe('markdown dialect', () => {
  it('closes emphasis next to CJK punctuation (plain CommonMark leaves it literal)', () => {
    const source = '**重要提示（Important）：**请注意';
    expect(collect(parseMarkdown(source), 'strong').map(textOf)).toEqual(['重要提示（Important）：']);
    const commonmark = unified().use(remarkParse).parse(source) as Root;
    expect(collect(commonmark, 'strong')).toHaveLength(0);
  });

  it('strikes through only with two tildes: two home paths on a line stay paths (#7199)', () => {
    const paths = '写好本周周报草稿（~/周报.md、~/周报-claude.md）';
    expect(collect(parseMarkdown(paths), 'delete')).toHaveLength(0);
    expect(textOf(parseMarkdown(paths))).toBe(paths);
    expect(collect(parseMarkdown('~~作废~~ 和 ~~删掉~~'), 'delete').map(textOf)).toEqual(['作废', '删掉']);
    expect(collect(parseMarkdown('**不对**~~这一句~~，'), 'delete').map(textOf)).toEqual(['这一句']);
  });

  it('ends a bare URL at CJK sentence punctuation', () => {
    const tree = run('访问 https://example.com/a。然后继续', { trust: 'chat' });
    const [link] = collect(tree, 'link');
    expect(link && 'url' in link ? link.url : null).toBe('https://example.com/a');
    expect(textOf(tree)).toContain('。然后继续');
  });

  it('keeps raw HTML and images literal for chat trust, and parses them for documents', () => {
    const source = 'hi <b>bold</b> ![pic](https://example.com/p.png)';
    const chat = run(source, { trust: 'chat' });
    expect(collect(chat, 'html')).toHaveLength(0);
    expect(collect(chat, 'image')).toHaveLength(0);
    expect(textOf(chat)).toBe('hi <b>bold</b> ![pic](https://example.com/p.png)');

    const document = run(source, { trust: 'document' });
    expect(collect(document, 'html').length).toBeGreaterThan(0);
    expect(collect(document, 'image')).toHaveLength(1);
  });

  it('keeps image nodes in chat only for a surface that asks (and never loads them)', () => {
    expect(collect(run('![pic](a.png) <b>x</b>', { trust: 'chat', keepImageNodes: true }), 'image')).toHaveLength(1);
    expect(collect(run('![pic](a.png) <b>x</b>', { trust: 'chat', keepImageNodes: true }), 'html')).toHaveLength(0);
    expect(collect(run('![pic](a.png)', { trust: 'chat' }), 'image')).toHaveLength(0);
  });

  it('turns typed line breaks into breaks only when asked', () => {
    expect(collect(run('one\ntwo', { trust: 'chat', hardBreaks: true }), 'break')).toHaveLength(1);
    expect(collect(run('one\ntwo', { trust: 'chat' }), 'break')).toHaveLength(0);
  });

  it('shows frontmatter as a yaml code block instead of a setext heading', () => {
    const tree = run('---\nname: x\n---\n\n# Title', { trust: 'document', frontmatter: true });
    expect(tree.children[0]).toMatchObject({ type: 'code', lang: 'yaml', value: 'name: x' });
    expect(collect(tree, 'heading')).toHaveLength(1);
  });

  it('parses GFM tables, task lists and math with one grammar', () => {
    const tree = parseMarkdown('| a |\n| - |\n| 1 |\n\n- [x] done\n\n$E=mc^2$');
    expect(collect(tree, 'table')).toHaveLength(1);
    expect(collect(tree, 'listItem')[0]).toMatchObject({ checked: true });
    expect(collect(tree, 'inlineMath')).toHaveLength(1);
  });

  it('keeps Windows drive paths as link targets and still drops other schemes', () => {
    const sanitize = unified().use(rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA);
    const hrefAfter = (href: string) => {
      const tree = { type: 'root', children: [{ type: 'element', tagName: 'a', properties: { href }, children: [] }] };
      const clean = sanitize.runSync(tree as never) as unknown as { children: { properties: { href?: unknown } }[] };
      return clean.children[0]?.properties.href;
    };
    expect(hrefAfter('C:\\Users\\me\\a.md')).toBe('C:\\Users\\me\\a.md');
    expect(hrefAfter('d:/work/a.md')).toBe('d:/work/a.md');
    // 摩擦单 F10: a group's file link keeps its href (dropped before, so the link clicked to nothing).
    const groupFile = 'gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(hrefAfter(groupFile)).toBe(groupFile);
    const conversation = 'gugu-chat://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/11111111-2222-4333-8444-555555555555';
    expect(hrefAfter(conversation)).toBe(conversation);
    expect(hrefAfter('javascript:alert(1)')).toBeUndefined();
    expect(hrefAfter('ab:x')).toBeUndefined();
    // An image may name a group's file (an App page's markdown draws it); no other new scheme reaches an image.
    const srcAfter = (src: string) => {
      const tree = { type: 'root', children: [{ type: 'element', tagName: 'img', properties: { src }, children: [] }] };
      return (sanitize.runSync(tree as never) as unknown as { children: { properties: { src?: unknown } }[] }).children[0]?.properties.src;
    };
    expect(srcAfter(groupFile)).toBe(groupFile);
    expect(srcAfter('gugu-chat://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBeUndefined();
    expect(srcAfter('javascript:alert(1)')).toBeUndefined();
  });

  // #6950: GitHub's anchors (github-slugger's rule and its numbering of repeats), prefixed by the sanitizer.
  it('slugs heading text the way GitHub does', () => {
    expect(githubSlug('Install Steps')).toBe('install-steps');
    expect(githubSlug('中文 标题')).toBe('中文-标题');
    expect(githubSlug('C++ & Rust: why?')).toBe('c--rust-why');
    expect(githubSlug('API_v2 (beta)')).toBe('api_v2-beta');
    expect(githubSlug('Ünïcödé Title')).toBe('ünïcödé-title');
  });

  it('gives each heading its anchor id once per document, before the sanitizer prefixes it', () => {
    const heading = (tagName: string, value: string) => ({
      type: 'element',
      tagName,
      properties: {},
      children: [{ type: 'text', value }],
    });
    const tree = {
      type: 'root',
      children: [
        heading('h1', 'Heading test 6950'),
        heading('h2', 'Install Steps'),
        heading('h3', '中文 标题'),
        heading('h2', 'Install Steps'),
        heading('h2', 'Install Steps'),
        heading('p', 'Not a heading'),
      ],
    };
    const out = unified().use(markdownRehypePlugins({ trust: 'chat' })).runSync(tree as never) as unknown as {
      children: { properties: { id?: string } }[];
    };
    expect(out.children.map((child) => child.properties.id ?? null)).toEqual([
      'user-content-heading-test-6950',
      'user-content-install-steps',
      'user-content-中文-标题',
      'user-content-install-steps-1',
      'user-content-install-steps-2',
      null,
    ]);
  });

  it('rewrites LaTeX-native delimiters to the dollar forms', () => {
    expect(normalizeMarkdownSource('area \\(x^2\\)')).toBe('area $x^2$');
    expect(normalizeMarkdownSource('`\\(kept\\)`')).toBe('`\\(kept\\)`');
  });
});
