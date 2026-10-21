/**
 * parse.test.ts — unit tests for the transcript's markdown parser.
 *
 * Covers:
 *  - Bracket @[label](target) form (new canonical form for file mentions)
 *  - Bare @token form (legacy agent output, still supported)
 *  - AT_TOKEN_RE trailing-dot stripping
 *  - /command slash tokens
 *  - Which nodes stay in a text run and which split off into blocks of their own
 *
 * Mentions are read back from the chips in the block's HTML: that markup is what
 * gets painted, hovered and clicked.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import type { CommandProvider } from './command-provider';
import type { HtmlBlock, MathBlock } from './document';
import { blockPlainText } from './plain-text';
import type { MentionProvider } from './mention-provider';
import { parseMarkdownToBlocks } from './parse';

// Stub provider that resolves any token it receives as a 'file' mention so
// every matched token becomes a pill without needing a registry of known paths.
const echoProvider: MentionProvider = {
  resolve: (token) => ({ id: token, label: token, kind: 'file' }),
};

const nullProvider: MentionProvider = { resolve: () => null };

function htmlBlocks(blocks: ReturnType<typeof parseMarkdownToBlocks>): HtmlBlock[] {
  return blocks.filter((b): b is HtmlBlock => b.kind === 'html');
}

/** The painted markup of every text run, in one element. `null` = no mention provider at all. */
function rendered(
  text: string,
  mentionProvider: MentionProvider | null = echoProvider,
  commandProvider?: CommandProvider
): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = htmlBlocks(parseMarkdownToBlocks('t', text, mentionProvider ?? undefined, commandProvider))
    .map((block) => block.html)
    .join('');
  return root;
}

function chips(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.gg-md-mention'));
}

/** What each chip shows (the provider's short name, else the label). */
function mentionLabels(root: HTMLElement): string[] {
  return chips(root).map((chip) => chip.textContent ?? '');
}

/** Stable ids (target path) of the chips. */
function mentionIds(root: HTMLElement): Array<string | undefined> {
  return chips(root).map((chip) => chip.dataset.mentionId);
}

// ── Bracket @[label](target) form ─────────────────────────────────────────────

describe('bracket @[label](target) mention form', () => {
  const bracketCases = [
    ['@[file.ts](/path/to/file.ts)', ['file.ts'], ['/path/to/file.ts']],
    ['@[a](<path with spaces/a.ts>)', ['a'], ['path with spaces/a.ts']],
    ['@[foo.ts](</Users/me/My Project/foo.ts>)', ['foo.ts'], ['/Users/me/My Project/foo.ts']],
    ['Look at @src/foo.ts and @[bar.ts](/path/bar.ts)', ['src/foo.ts', 'bar.ts'], ['src/foo.ts', '/path/bar.ts']],
  ] as const;
  it.each(bracketCases)('resolves %s into mention chips', (text, labels, ids) => {
    const root = rendered(text);
    expect(mentionLabels(root)).toEqual(labels);
    expect(mentionIds(root)).toEqual(ids);
  });

  it('resolves a bracket mention preceded by prose text', () => {
    const root = rendered('See @[foo.ts](/path/foo.ts) for details');
    expect(mentionLabels(root)).toEqual(['foo.ts']);
    expect(mentionIds(root)).toEqual(['/path/foo.ts']);
    expect(root.textContent).toBe('See foo.ts for details');
  });

  it('still folds bracket form when provider returns null (bracket = explicitly authored)', () => {
    const root = rendered('@[file.ts](/path/to/file.ts)', nullProvider);
    expect(mentionLabels(root)).toEqual(['file.ts']);
    expect(root.querySelector('a')).toBeNull();
  });

  /**
   * 输入框里那枚附件 chip 显示的是 `code-card.png`,而落盘的文件名带一段 uuid。
   * provider 只看得见 target,给出的短名就是那个 uuid 名 —— 消息发出去之后,
   * 传输路径就爬到了用户脸上(#5269)。显式写出的 label 必须赢过它。
   */
  it('显式 label 赢过 provider 由路径推出来的短名', () => {
    const basenameProvider: MentionProvider = {
      resolve: (token) => ({ id: token, label: token, name: token.split('/').pop(), kind: 'file' }),
    };
    const root = rendered('@[code-card.png](/tmp/gugu-dropped-blobs/gugu-drop-uuid-code-card.png)', basenameProvider);
    expect(mentionLabels(root)).toEqual(['code-card.png']);
    expect(mentionIds(root)).toEqual(['/tmp/gugu-dropped-blobs/gugu-drop-uuid-code-card.png']);
  });

  it('label 与 target 逐字相同时仍截成短名(agent 惯写的那种 mention 不受影响)', () => {
    // 阴控:少了这一条,上面那条在「label 永远赢」的实现下也绿,而那会把
    // agent 写的 `@[src/auth/jwt.ts](src/auth/jwt.ts)` 从 `jwt.ts` 撑成整条路径。
    const basenameProvider: MentionProvider = {
      resolve: (token) => ({ id: token, label: token, name: token.split('/').pop(), kind: 'file' }),
    };
    expect(mentionLabels(rendered('@[src/auth/jwt.ts](src/auth/jwt.ts)', basenameProvider))).toEqual(['jwt.ts']);
  });

  it('does not fold when no mention provider is supplied', () => {
    // Without a provider, bracket links appear as linked text (not pills)
    const root = rendered('@[file.ts](/path/to/file.ts)', null);
    expect(chips(root)).toHaveLength(0);
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/path/to/file.ts');
  });
});

// ── Trailing dot stripping ─────────────────────────────────────────────────

describe('bare @token trailing-dot stripping', () => {
  const cases = [
    ['Edit @hello.ts.', ['hello.ts']],
    ['See @src/auth/jwt.ts.', ['src/auth/jwt.ts']],
    ['@src/auth/jwt.ts is new', ['src/auth/jwt.ts']],
    ['@a.ts. and @b.ts.', ['a.ts', 'b.ts']],
  ] as const;
  it.each(cases)('parses %s', (text, labels) => {
    expect(mentionLabels(rendered(text))).toEqual(labels);
  });
});

// ── Internal and leading dots preserved ───────────────────────────────────

describe('bare @token dot preservation', () => {
  const cases = [
    ['@src/auth/jwt.ts', ['src/auth/jwt.ts']],
    ['Ignored @.gitignore file', ['.gitignore']],
    ['@foo.bar.baz', ['foo.bar.baz']],
  ] as const;
  it.each(cases)('preserves dots in %s', (text, labels) => {
    expect(mentionLabels(rendered(text))).toEqual(labels);
  });
});

// ── Other bare token shapes ──────────────────────────────────────────────

describe('bare @token standard shapes', () => {
  const cases = [
    ['Closes @issue-42', ['issue-42']],
    ['Call @handleSubmit()', ['handleSubmit()']],
    ['@foo.ts and @bar-baz and @qux()', ['foo.ts', 'bar-baz', 'qux()']],
  ] as const;
  it.each(cases)('matches %s', (text, labels) => {
    expect(mentionLabels(rendered(text))).toEqual(labels);
  });

  it('returns no mentions when provider returns null for bare tokens', () => {
    const root = rendered('@hello.ts', nullProvider);
    expect(chips(root)).toHaveLength(0);
    expect(root.textContent).toBe('@hello.ts');
  });

  it('carries local-agent title and harness metadata into the rendered chip', () => {
    const provider: MentionProvider = {
      resolve: (token) =>
        token === 'user:agent-1'
          ? {
              id: token,
              label: token,
              name: 'Codex 1',
              kind: 'custom',
              title: 'Fix the delivery route',
              engine: 'codex',
              iconUrl: 'data:image/svg+xml,codex',
            }
          : null,
    };
    const [chip] = chips(rendered('@user:agent-1 (name: Codex 1)', provider));

    expect(chip?.textContent).toBe('Codex 1');
    expect(chip?.dataset).toMatchObject({
      mentionId: 'user:agent-1',
      mentionKind: 'custom',
      mentionTitle: 'Fix the delivery route',
      mentionEngine: 'codex',
    });
    expect(chip?.querySelector<HTMLElement>('.gg-md-mention-icon')?.dataset.iconUrl).toBe('data:image/svg+xml,codex');
  });
});

// ── /command slash tokens ─────────────────────────────────────────────────

describe('/command slash tokens', () => {
  it('resolves /review at start of line', () => {
    const commandProvider: CommandProvider = {
      resolve: (name) => (name === 'review' ? { name: 'review' } : null),
    };
    const found = chips(rendered('/review the changes', null, commandProvider));
    expect(found).toHaveLength(1);
    expect(found[0]!.textContent).toBe('/review');
    expect(found[0]!.dataset.mentionTone).toBe('command');
  });

  it('does not match a slash in the middle of a path', () => {
    const commandProvider: CommandProvider = {
      resolve: (name) => ({ name }),
    };
    // Bare text — the slash in "path/to" is NOT at line start or after whitespace
    // so SLASH_PATTERN should not match it.
    expect(chips(rendered('See path/to/file', null, commandProvider))).toHaveLength(0);
  });
});

// ── Which nodes share a text run ─────────────────────────────────────────────

describe('text runs', () => {
  it('keeps a thematic break inside the run around it', () => {
    const blocks = parseMarkdownToBlocks('t', 'before\n\n---\n\nafter');
    expect(blocks.map((block) => block.kind)).toEqual(['html']);
    expect(htmlBlocks(blocks)[0]!.html).toBe('<p>before</p>\n<hr>\n<p>after</p>');
    expect(blocks[0]!.id).toBe('t#0');
  });

  it.each([
    ['> Hello world', 1],
    ['> > Nested', 2],
    ['Hello world', 0],
  ] as const)('renders %s with %i blockquote level(s)', (text, depth) => {
    const root = rendered(text);
    expect(root.querySelectorAll('blockquote')).toHaveLength(depth);
    expect(root.textContent?.trim()).toBe(text.replaceAll('> ', ''));
  });

  it('gives code, display math and mermaid blocks of their own, ids in document order', () => {
    const blocks = parseMarkdownToBlocks('t', 'a\n\n```ts\nx\n```\n\nb\n\n$$\ny\n$$\n\n```mermaid\ngraph TD\n```\n\nc');
    expect(blocks.map((block) => `${block.kind}:${block.id}`)).toEqual([
      'html:t#0',
      'code:t#1',
      'html:t#2',
      'math:t#3',
      'mermaid:t#4',
      'html:t#5',
    ]);
  });

  it('reads like the chat bubble: raw HTML stays text, a typed newline is a line break', () => {
    const root = rendered('<details><span id="gg-mention-0">x</span></details>\none\ntwo');
    expect(root.querySelector('details, span[id]')).toBeNull();
    expect(chips(root)).toHaveLength(0);
    expect(root.textContent).toContain('<details>');
    expect(root.querySelectorAll('br')).toHaveLength(2);
    expect(blockPlainText(parseMarkdownToBlocks('t', 'one\ntwo')[0]!)).toBe('one\ntwo');
  });

  it('paints an image as a link to its source, never as an image', () => {
    const root = rendered('![截图](shots/a.png)');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('a.gg-md-image')?.getAttribute('href')).toBe('shots/a.png');
    expect(root.textContent).toBe('截图');
  });

  it('continues ids from startN (streaming tails)', () => {
    expect(parseMarkdownToBlocks('t', 'a\n\n```\nx\n```', undefined, undefined, 7).map((block) => block.id)).toEqual([
      't#7',
      't#8',
    ]);
  });
});

// ── Math: both delimiter families, both modes ────────────────────────────────

describe('LaTeX reaches the document model as math, not as text', () => {
  it('inline $…$ is typeset in the run, and its source is what a reader gets', () => {
    const blocks = parseMarkdownToBlocks('t', 'Energy is $E = mc^2$ here.', nullProvider);
    const root = rendered('Energy is $E = mc^2$ here.', nullProvider);
    expect(root.querySelectorAll('.katex')).toHaveLength(1);
    expect(root.querySelector('annotation')?.textContent).toBe('E = mc^2');
    expect(blocks.map(blockPlainText)).toEqual(['Energy is E = mc^2 here.']);
    // The state this replaced: a mention chip labelled '∑ math'. Reading for it
    // by name is what makes this a regression test rather than a smoke test.
    expect(mentionLabels(root)).not.toContain('∑ math');
  });

  it('display $$…$$ becomes a math block, not a paragraph of LaTeX', () => {
    const blocks = parseMarkdownToBlocks('t', 'Before\n\n$$\n\\frac{a}{b}\n$$\n\nAfter');
    const math = blocks.filter((block): block is MathBlock => block.kind === 'math');
    expect(math).toHaveLength(1);
    expect(math[0]!.tex.trim()).toBe('\\frac{a}{b}');
    // A text run still holding the source would mean a second math path is live.
    expect(htmlBlocks(blocks).map((block) => block.text)).toEqual(['Before', 'After']);
  });

  it('LaTeX-native \\(…\\) and \\[…\\] parse the same as the dollar forms', () => {
    const dollars = parseMarkdownToBlocks('t', 'Energy is $E = mc^2$\n\n$$\n\\frac{a}{b}\n$$');
    const latex = parseMarkdownToBlocks('t', 'Energy is \\(E = mc^2\\)\n\n\\[\n\\frac{a}{b}\n\\]');

    const shape = (blocks: ReturnType<typeof parseMarkdownToBlocks>) =>
      blocks.map((block) => (block.kind === 'math' ? `math:${block.tex.trim()}` : `${block.kind}:${blockPlainText(block)}`));

    expect(shape(latex)).toEqual(shape(dollars));
    expect(shape(latex)).toEqual(['html:Energy is E = mc^2', 'math:\\frac{a}{b}']);
  });

  it('leaves LaTeX inside code spans and fences alone', () => {
    const root = rendered('Write `\\(x\\)` to get math.', nullProvider);
    expect(root.querySelector('.katex')).toBeNull();
    expect(Array.from(root.querySelectorAll('code')).map((code) => code.textContent)).toEqual(['\\(x\\)']);

    const fenced = parseMarkdownToBlocks('t', '```\n\\[ x \\]\n```');
    expect(fenced.map((block) => block.kind)).toEqual(['code']);
  });

  it('carries the source into the plain-text mirror rather than dropping it', () => {
    const blocks = parseMarkdownToBlocks('t', 'Ratio $\\frac{a}{b}$\n\n$$\nx^2\n$$');
    expect(blocks.map(blockPlainText)).toEqual(['Ratio \\frac{a}{b}', 'x^2']);
  });
});
