/**
 * The one markdown dialect of Gugu.
 *
 * Every surface parses with these remark plugins, sanitizes with this schema and
 * normalizes source text with `normalizeMarkdownSource` — the React `<Markdown>`
 * component (chat, previews, documents) and the transcript's DOM blocks alike. A
 * message therefore cannot mean one thing in a chat bubble and another in the
 * transcript; a surface only chooses a trust level, never its own grammar.
 *
 * Trust levels:
 *  - `chat`: other people's words. Raw HTML and images stay literal text — no
 *    markup passthrough and no remote request on render (#1536/#1734).
 *  - `document`: the user's own files, PR comments, extension notes. Raw HTML is
 *    parsed and then sanitized; images are rendered.
 */

import type { Link, Nodes, Parent, Root, RootContent, Text } from 'mdast';
import { normalizeLatexMathDelimitersWithLines } from '@gugu/core/shared/markdownMath.mjs';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified, type Pluggable, type PluggableList } from 'unified';
import { normalizeWindowsMarkdownFileLinks } from './mention-grammar';
import { remarkPandocDollarMath } from './pandoc-dollar-math';

export type MarkdownTrust = 'chat' | 'document';

export type MarkdownDialectOptions = {
  trust: MarkdownTrust;
  /** Render a single `\n` inside a paragraph as a line break (typed human messages). */
  hardBreaks?: boolean;
  /** Parse a leading `---` YAML block as frontmatter and show it as a yaml code block (files only). */
  frontmatter?: boolean;
  /** `chat` trust: images stay image nodes, for a surface that paints them without loading them (link chips). */
  keepImageNodes?: boolean;
};

/** String-level rewrites that must happen before tokenising (a parsed tree has already decided what is math). */
export function normalizeMarkdownSource(text: string): string {
  return normalizeMarkdownSourceWithLines(text).text;
}

/**
 * The same rewrites, and `lineOf(n)`: the given text's line (from 1) that the rewritten text's line n came from — what a
 * parsed node's position says, read back in the lines a person wrote. (The file links are rewritten line by line.)
 */
export function normalizeMarkdownSourceWithLines(text: string): { text: string; lineOf: (line: number) => number } {
  const math = normalizeLatexMathDelimitersWithLines(text);
  return { text: normalizeWindowsMarkdownFileLinks(math.text), lineOf: math.lineOf };
}

// CJK sentence punctuation ends a bare URL: GFM autolinks would otherwise swallow `。` / `，` into the link.
const CJK_URL_STOPS = new Set('。．，、？！：；（）【】「」『』〈〉《》');
const BARE_URL = /^(https?:\/\/|mailto:|www\.)/i;

function remarkCjkAutolinkBoundary() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      for (let i = 0; i < parent.children.length; i += 1) {
        const node = parent.children[i] as Nodes;
        if (node.type === 'link' && isBareUrl(node)) {
          const cut = [...node.url].findIndex((ch) => CJK_URL_STOPS.has(ch));
          if (cut > 0) {
            const chars = [...node.url];
            const url = chars.slice(0, cut).join('');
            const rest: Text = { type: 'text', value: chars.slice(cut).join('') };
            parent.children.splice(i, 1, { ...node, url, children: [{ type: 'text', value: url }] }, rest);
            i += 1;
          }
        } else if ('children' in node) {
          visit(node as Parent);
        }
      }
    };
    visit(tree);
  };
}

function isBareUrl(link: Link): boolean {
  const only = link.children[0];
  return link.children.length === 1 && only?.type === 'text' && only.value === link.url && BARE_URL.test(link.url);
}

/**
 * The grammar. `remark-cjk-friendly` must run before gfm, its strikethrough twin after. Single-dollar math is read the
 * pandoc way (no space inside the dollars, no digit right after the closing one), so prices stay prose.
 * Strikethrough takes two tildes (`singleTilde: false`, what GFM itself specifies): with one, two home paths on a line
 * (`~/周报.md、~/周报-claude.md`) struck out everything between them (#7199) — agents write `~/…` all the time.
 */
const GRAMMAR: PluggableList = [
  remarkCjkFriendly,
  [remarkGfm, { singleTilde: false }],
  [remarkCjkFriendlyGfmStrikethrough, { singleTilde: false }],
  remarkCjkAutolinkBoundary,
  [remarkMath, { singleDollarTextMath: true }],
  remarkPandocDollarMath,
];

const parser = unified().use(remarkParse).use(GRAMMAR).freeze();

/** Parse with the dialect's grammar (no transforms) — for callers that must agree with what renders. */
export function parseMarkdown(text: string): Root {
  return parser.parse(text);
}

/** Explicit @[label](target) references, using the same AST as message rendering. */
export function markdownMentionReferences(text: string): Array<{ start: number; end: number; label: string; target: string }> {
  if (!text.includes('@[')) return [];
  const references: Array<{ start: number; end: number; label: string; target: string }> = [];
  const labelOf = (node: Nodes): string =>
    'value' in node ? node.value : 'children' in node ? node.children.map(labelOf).join('') : '';
  const walk = (parent: Nodes) => {
    if (!('children' in parent)) return;
    const children = parent.children;
    children.forEach((node, index) => {
      if (node.type === 'link') {
        const previous = children[index - 1];
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (previous?.type !== 'text' || !previous.value.endsWith('@') || start == null || end == null) return;
        let slashes = 0;
        for (let at = start - 2; at >= 0 && text[at] === '\\'; at--) slashes++;
        if (text[start - 1] === '@' && slashes % 2 === 0) {
          references.push({ start: start - 1, end, label: labelOf(node), target: node.url });
        }
      } else if ('children' in node) {
        walk(node);
      }
    });
  };
  walk(parseMarkdown(text));
  return references;
}

function imageLiteral(node: Nodes): string {
  if (node.type === 'image') return `![${node.alt ?? ''}](${node.url}${node.title ? ` "${node.title}"` : ''})`;
  if (node.type !== 'imageReference') return '';
  if (node.referenceType === 'collapsed') return `![${node.alt ?? ''}][]`;
  if (node.referenceType === 'shortcut') return `![${node.alt ?? ''}]`;
  return `![${node.alt ?? ''}][${node.label ?? node.identifier}]`;
}

/** `chat` trust: raw HTML and images become their literal source text. */
function remarkLiteralizeUntrusted(options: { keepImages?: boolean } = {}) {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      parent.children = parent.children.map((child) => {
        const node = child as Nodes;
        if (node.type === 'html') return { type: 'text', value: node.value } as Text as RootContent;
        if ((node.type === 'image' || node.type === 'imageReference') && !options.keepImages) {
          return { type: 'text', value: imageLiteral(node) } as Text as RootContent;
        }
        if ('children' in node) visit(node as Parent);
        return child;
      });
    };
    visit(tree);
  };
}

/** A `\n` inside a text node becomes a `break` (a typed Shift+Enter is an intended line break). */
function remarkHardBreaks() {
  return (tree: Root) => {
    const visit = (parent: Parent) => {
      parent.children = parent.children.flatMap((child) => {
        const node = child as Nodes;
        if (node.type === 'text' && node.value.includes('\n')) {
          return node.value.split('\n').flatMap((part, i) => {
            const out: RootContent[] = i > 0 ? [{ type: 'break' }] : [];
            if (part) out.push({ type: 'text', value: part });
            return out;
          });
        }
        if ('children' in node) visit(node as Parent);
        return [child];
      });
    };
    visit(tree);
  };
}

/** Frontmatter is shown as a yaml code block — never as a setext heading (#5375). */
function remarkFrontmatterAsCode() {
  return (tree: Root) => {
    const first = tree.children[0];
    if (first?.type !== 'yaml') return;
    tree.children[0] = { type: 'code', lang: 'yaml', value: first.value, position: first.position };
  };
}

/** A frozen parser with the dialect; `extra` remark transforms (a surface's own) run after the dialect's. */
export function createMarkdownParser(options: MarkdownDialectOptions, extra: PluggableList = []) {
  return unified().use(remarkParse).use(markdownRemarkPlugins(options)).use(extra).freeze();
}

export function markdownRemarkPlugins(options: MarkdownDialectOptions): PluggableList {
  const literalize: Pluggable = [remarkLiteralizeUntrusted, { keepImages: options.keepImageNodes }];
  return [
    ...(options.frontmatter ? [remarkFrontmatter, remarkFrontmatterAsCode] : []),
    ...GRAMMAR,
    ...(options.trust === 'chat' ? [literalize] : []),
    ...(options.hardBreaks ? [remarkHardBreaks] : []),
  ];
}

/** A Windows drive path (`C:\…`, `C:/…`) reads to the sanitizer as a one-letter scheme; no URL scheme is one letter. */
const DRIVE_LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].flatMap((letter) => [letter, letter.toLowerCase()]);

/**
 * GitHub's schema plus `tel:` links, Windows drive paths (agents link files that way; the host classifies
 * and opens them) and `gugu-file:` links to a group's files (摩擦单 F10 — without it the link lost its href and
 * clicked to nothing). Math is typeset after sanitizing, so KaTeX output is not filtered.
 */
export const MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'tel', 'gugu-file', 'gugu-chat', ...DRIVE_LETTERS],
  },
};

// KaTeX renders top-level `\\` in display math but warns that it is not portable LaTeX. Gugu never compiles
// with real LaTeX, so only that warning is noise; every other strict diagnostic stays a warning.
const KATEX_OPTIONS = {
  errorColor: 'currentColor',
  strict: (code: string) => (code === 'newLineInDisplayMode' ? 'ignore' : 'warn'),
};

/** GitHub's heading anchor: lower-cased; all but letters, marks, numbers, `_`, `-` and spaces dropped; spaces → `-`. */
export function githubSlug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };
const hastText = (node: HastNode): string =>
  node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(hastText).join('');

/**
 * Headings carry GitHub's anchor ids (#6950): `## Install Steps` → `install-steps`, its repeat `install-steps-1`,
 * `### 中文 标题` → `中文-标题`, counted per document as github-slugger counts. It runs before the sanitizer, which
 * prefixes every id (`clobberPrefix` → `user-content-install-steps`) exactly as GitHub's does, so a document's ids
 * never clobber the app's; a `#install-steps` link resolves to the prefixed id (`revealMarkdownAnchor`).
 */
function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const taken = new Map<string, number>();
    const visit = (node: HastNode) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '') && !node.properties?.id) {
        const base = githubSlug(hastText(node));
        if (base) {
          let slug = base;
          while (taken.has(slug)) {
            const count = (taken.get(base) ?? 0) + 1;
            taken.set(base, count);
            slug = `${base}-${count}`;
          }
          taken.set(slug, 0);
          node.properties = { ...node.properties, id: slug };
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/**
 * `afterSanitize` is where a surface projects its own interactive pieces (the transcript's mention and image
 * chips) — after the one sanitize pass, so they never need an exception in the shared schema.
 */
export function markdownRehypePlugins(
  options: MarkdownDialectOptions,
  afterSanitize: PluggableList = []
): PluggableList {
  return [
    ...(options.trust === 'document' ? [rehypeRaw] : []),
    rehypeHeadingIds,
    [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA],
    ...afterSanitize,
    [rehypeKatex, KATEX_OPTIONS],
  ];
}
