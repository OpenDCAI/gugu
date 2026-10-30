/**
 * to-html — parsed mdast → transcript blocks, and a whole document → one HTML string.
 *
 * Each run of text-like top-level nodes becomes one `html` block; top-level code,
 * display math and mermaid split the runs and keep kinds of their own. The hast
 * pipeline is the shared dialect's (sanitized, math typeset), so the transcript
 * paints the markup every other markdown surface paints. The whole
 * tree goes through one `toHast` call: link and footnote definitions resolve
 * across runs.
 *
 * `documentToHtml` is the same pipeline without the split, for a page that paints a
 * whole document itself (an App page, through `gugu.markdown()`).
 *
 * After the one sanitize pass this module projects three things of its own (and, for a whole document, a code block's
 * head and front matter as properties — `rehypeDocumentBlocks`):
 *  - mention chips, carrying the attributes hover and click read;
 *  - images as link chips: a picture's box is unknown until it loads, and a row's
 *    height has to be known before it paints; nothing is fetched on render;
 *  - a scroll box around each table, so a wide table scrolls instead of being
 *    clipped at the row's edge.
 *
 * This module is PURE: no geometry, no DOM imports.
 */

import {
  createMarkdownParser,
  markdownRehypePlugins,
  normalizeMarkdownSourceWithLines,
  type MarkdownDialectOptions,
} from '@gugu/session-shared/markdown/dialect';
import type { Element, ElementContent, Root as HastRoot } from 'hast';
import { toHtml } from 'hast-util-to-html';
import type { Nodes, Root, RootContent } from 'mdast';
import { toHast, type State } from 'mdast-util-to-hast';
import { unified } from 'unified';
import type { Block, BlockId, HtmlBlock } from './document';
import type { MdastMention } from './mdast-mention';

/**
 * The transcript shows chat messages (delivered IM, the user's prompts) next to agent replies, so it reads with
 * `chat` trust like the chat bubble: raw HTML stays literal text and a typed newline is a line break. Images stay
 * nodes because the transcript paints them as link chips and never loads them.
 */
export const TRANSCRIPT_DIALECT = { trust: 'chat', hardBreaks: true, keepImageNodes: true } as const;

/** `id` survives the sanitize schema (clobber-prefixed), so a chip can be put back where its slot was. */
const MENTION_SLOT = 'gg-mention-';
const SANITIZED_MENTION_SLOT = `user-content-${MENTION_SLOT}`;
const ARTIFACT_TAG = 'gg-artifact';

type ArtifactNode = { type: 'ggArtifact'; index: number };

function mentionLabel(mention: MdastMention): string {
  return mention.tone === 'command' ? mention.label : (mention.name ?? mention.label);
}

function mentionChip(mention: MdastMention): Element {
  const id = mention.target ?? mention.label;
  const label: ElementContent = { type: 'text', value: mentionLabel(mention) };
  const icon: Element = {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['gg-md-mention-icon'],
      dataIcon: mention.iconUrl ? 'url' : mention.iconClass ? 'class' : mention.mentionKind,
      dataIconUrl: mention.iconUrl,
      dataIconClass: mention.iconClass,
    },
    children: [],
  };
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['gg-md-mention'],
      dataMentionId: id,
      dataMentionLabel: mention.label,
      dataMentionKind: mention.mentionKind,
      dataMentionEngine: mention.engine,
      dataMentionTitle: mention.title,
      dataMentionTone: mention.tone,
      title: mention.title ? `${id} · ${mention.title}` : id,
    },
    children: mention.mentionKind ? [icon, label] : [label],
  };
}

function imageChip(image: Element): Element {
  const src = typeof image.properties.src === 'string' ? image.properties.src : '';
  const alt = typeof image.properties.alt === 'string' && image.properties.alt ? image.properties.alt : src;
  return {
    type: 'element',
    tagName: src ? 'a' : 'span',
    properties: { className: ['gg-md-image'], ...(src ? { href: src } : {}) },
    children: [{ type: 'text', value: alt }],
  };
}

function rehypeChips(mentions: readonly MdastMention[]) {
  return () => (tree: HastRoot) => {
    const visit = (parent: HastRoot | Element) => {
      parent.children = parent.children.map((child) => {
        if (child.type !== 'element') return child;
        const slot = typeof child.properties.id === 'string' ? child.properties.id : '';
        const index = slot.startsWith(SANITIZED_MENTION_SLOT) ? Number(slot.slice(SANITIZED_MENTION_SLOT.length)) : -1;
        const mention = mentions[index];
        if (mention) return mentionChip(mention);
        if (child.tagName === 'img') return imageChip(child);
        visit(child);
        if (child.tagName !== 'table') return child;
        return { type: 'element', tagName: 'div', properties: { className: ['gg-md-table-scroll'] }, children: [child] };
      });
    };
    visit(tree);
  };
}

function artifactBlock(node: RootContent, id: BlockId): Block {
  if (node.type === 'math') return { kind: 'math', id, tex: node.value };
  if (node.type !== 'code') throw new Error(`not an artifact node: ${node.type}`);
  const lang = node.lang?.toLowerCase();
  if (lang === 'mermaid' || lang === 'mmd') return { kind: 'mermaid', id, source: node.value };
  return { kind: 'code', id, code: node.value, lang: node.lang ?? undefined };
}

/** What a reader sees: mention labels and formula sources included, markup excluded. */
function readerText(node: Nodes | MdastMention): string {
  if (node.type === 'mention') return mentionLabel(node as MdastMention);
  if (node.type === 'break') return '\n';
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return (node.children as Nodes[]).map(readerText).join('');
  return '';
}

/**
 * A literal `**` still waiting for its closing pair. remark leaves an unfinished emphasis opener as text;
 * painting it would flash the marker while the stream is still delivering the closer.
 */
function hasPendingStrong(nodes: readonly Nodes[]): boolean {
  for (const node of nodes) {
    // Table cells are not held back: a literal `**` in a cell (an unquoted glob) would hide the rest of the stream.
    if (!('children' in node) || node.type === 'table') continue;
    const children = node.children as Nodes[];
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.type !== 'text') continue;
      // With one closing star missing, remark reads the second opener star as `*` + an emphasis node.
      if (child.value.endsWith('*') && children[index + 1]?.type === 'emphasis') return true;
      let candidates = 0;
      for (let i = 0; i < child.value.length - 1; i += 1) {
        if (child.value[i] !== '*' || child.value[i + 1] !== '*') continue;
        const before = child.value[i - 1];
        const after = child.value[i + 2];
        // A pair surrounded by whitespace is exponent notation or a separator (`2 ** 3`), not an opener.
        if ((before && !/\s/u.test(before)) || (after && !/\s/u.test(after))) candidates += 1;
        i += 1;
      }
      if (candidates % 2 === 1) return true;
    }
    if (hasPendingStrong(children)) return true;
  }
  return false;
}

/** Split a parsed message into blocks; `nextId` hands out ids in document order. */
export function treeToBlocks(tree: Root, nextId: () => BlockId): Block[] {
  const artifacts: RootContent[] = [];
  const mentions: MdastMention[] = [];
  const children = tree.children.map((child): RootContent => {
    if (child.type !== 'code' && child.type !== 'math') return child;
    artifacts.push(child);
    return { type: 'ggArtifact', index: artifacts.length - 1, position: child.position } as unknown as RootContent;
  });
  const hast = toHast({ type: 'root', children }, {
    handlers: {
      ggArtifact: (_state: State, node: ArtifactNode): Element => ({
        type: 'element',
        tagName: ARTIFACT_TAG,
        properties: { dataIndex: node.index },
        children: [],
      }),
      mention: (_state: State, node: MdastMention): Element => {
        mentions.push(node);
        return { type: 'element', tagName: 'span', properties: { id: `${MENTION_SLOT}${mentions.length - 1}` }, children: [] };
      },
    } as never,
  }) as HastRoot;
  const rehype = unified().use(markdownRehypePlugins(TRANSCRIPT_DIALECT, [rehypeChips(mentions)])).freeze();

  // Which markdown nodes each html run came from (by source offset): their text feeds find and screen readers.
  const byOffset = new Map<number, RootContent>();
  for (const child of tree.children) {
    if (child.position?.start.offset !== undefined) byOffset.set(child.position.start.offset, child);
  }
  const claimed = new Set<RootContent>();
  const groups: { hast: ElementContent[]; md: RootContent[] }[] = [];
  const blocks: (Block | { group: number })[] = [];
  let open: { hast: ElementContent[]; md: RootContent[] } | null = null;
  for (const node of hast.children as ElementContent[]) {
    if (node.type === 'element' && node.tagName === ARTIFACT_TAG) {
      open = null;
      blocks.push(artifactBlock(artifacts[Number(node.properties.dataIndex)]!, ''));
      continue;
    }
    if (node.type === 'text' && !node.value.trim()) {
      open?.hast.push(node);
      continue;
    }
    if (!open) {
      open = { hast: [], md: [] };
      groups.push(open);
      blocks.push({ group: groups.length - 1 });
    }
    open.hast.push(node);
    const source = node.position?.start.offset === undefined ? undefined : byOffset.get(node.position.start.offset);
    if (source) {
      open.md.push(source);
      claimed.add(source);
    }
  }
  // Definitions paint nothing where they stand; their text belongs with the last run (the footnote list).
  const unclaimed = tree.children.filter((child) => !claimed.has(child) && child.type !== 'code' && child.type !== 'math');
  groups.at(-1)?.md.push(...unclaimed);

  return blocks.map((entry) => {
    if (!('group' in entry)) return { ...entry, id: nextId() } as Block;
    const group = groups[entry.group]!;
    const clean = rehype.runSync({ type: 'root', children: group.hast } as never) as unknown as HastRoot;
    const block: HtmlBlock = {
      kind: 'html',
      id: nextId(),
      html: toHtml(clean),
      text: group.md.map((node) => readerText(node)).join('\n\n'),
    };
    if (hasPendingStrong(group.md as Nodes[])) block.pendingStrong = true;
    return block;
  });
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * A whole document → one sanitized HTML string for `.gg-md`, with the transcript's image chips and table scroll boxes
 * (an image is a link chip in either trust: nothing is fetched on render). `document` trust keeps raw HTML for the
 * sanitizer to read; `chat` has turned it into text before.
 */
export function documentToHtml(text: string, options: MarkdownDialectOptions & { sourceLines?: boolean }): string {
  const parser = createMarkdownParser(options);
  const source = normalizeMarkdownSourceWithLines(text);
  const tree = parser.runSync(parser.parse(source.text)) as Root;
  // The dialect turned a leading `---` block into a yaml code node; a fenced ```yaml on line 1 starts with fences, not `---`.
  const frontmatter = !!options.frontmatter && /^---\r?\n/.test(source.text) && tree.children[0]?.type === 'code';
  const hast = toHast(tree, { allowDangerousHtml: options.trust === 'document' }) as HastRoot;
  const after = [...(options.sourceLines ? [rehypeSourceLines(source.lineOf)] : []), rehypeChips([]), rehypeDocumentBlocks(frontmatter)];
  const rehype = unified().use(markdownRehypePlugins(options, after)).freeze();
  return toHtml(rehype.runSync(hast as never) as unknown as HastRoot);
}

/**
 * `sourceLines`: each top-level block — and each list item and table row in it, the blocks a line is picked in — says
 * the lines of the given text it was written on: `data-line="3-5"` (from 1), so a page can find a line's block and a
 * block's lines. After the sanitizer, which keeps each node's position; read back through the rewrites (`lineOf`: a
 * one-line `$$…$$` is set as three). Display math says them on a `div` around its `pre`: KaTeX, after this, replaces the
 * `pre` whole.
 */
function rehypeSourceLines(lineOf: (line: number) => number) {
  const isMath = (node: Element) =>
    node.tagName === 'pre' && node.children.some((c) => c.type === 'element' && (c.properties.className as string[] | undefined)?.includes('language-math'));
  const stamp = (nodes: ElementContent[] | HastRoot['children'], top: boolean) => {
    nodes.forEach((node, i) => {
      if (node.type !== 'element') return;
      if (node.position && (top || node.tagName === 'li' || node.tagName === 'tr')) {
        const dataLine = `${lineOf(node.position.start.line)}-${lineOf(node.position.end.line)}`;
        if (isMath(node)) nodes[i] = { type: 'element', tagName: 'div', properties: { dataLine }, children: [node] };
        else node.properties = { ...node.properties, dataLine };
      }
      stamp(node.children, false);
    });
  };
  return () => (tree: HastRoot) => stamp(tree.children, true);
}

const element = (tagName: string, properties: Element['properties'], children: ElementContent[] = []): Element => ({ type: 'element', tagName, properties, children });
const textOf = (node: ElementContent): string => (node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(textOf).join('') : '');

/** Front matter as `key: value` pairs, or null when any line is more than that (nesting, lists, block scalars). */
function propertiesOf(yaml: string): [string, string][] | null {
  const pairs: [string, string][] = [];
  for (const line of yaml.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pair = /^([^\s:#][^:]*):[ \t]+(\S.*)$/.exec(line);
    if (!pair || /^[|>]/.test(pair[2]!)) return null;
    pairs.push([pair[1]!.trim(), pair[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')]);
  }
  return pairs.length ? pairs : null;
}

/**
 * A document's own furniture, for a page that paints a whole document (`documentToHtml`; the transcript draws code
 * blocks itself): each code block gets a head with its language and a copy button (`data-gg-copy`, which the page
 * wires), and plain `key: value` front matter reads as a property list (`dl.gg-md-props`) instead of a yaml block.
 * Both keep the block's `data-line`. Built after the sanitizer from its output: only text and fixed markup go in.
 */
function rehypeDocumentBlocks(frontmatter: boolean) {
  return () => (tree: HastRoot) => {
    const first = tree.children.findIndex((node) => node.type === 'element');
    tree.children = tree.children.map((node, index) => {
      if (node.type !== 'element' || node.tagName !== 'pre') return node;
      const code = node.children.find((child): child is Element => child.type === 'element' && child.tagName === 'code');
      if (!code) return node;
      const lang = ((code.properties.className as string[] | undefined) ?? []).find((name) => name.startsWith('language-'))?.slice(9) ?? '';
      // Math is set by KaTeX after this; a diagram is drawn by the page in place of its `pre`.
      if (lang === 'math' || lang === 'mermaid' || lang === 'mmd') return node;
      const { dataLine, ...properties } = node.properties;
      const line = dataLine === undefined ? {} : { dataLine };
      const pairs = frontmatter && index === first && lang === 'yaml' ? propertiesOf(textOf(code)) : null;
      if (pairs) {
        return element('dl', { className: ['gg-md-props'], ...line }, pairs.flatMap(([key, value]) => [element('dt', {}, [{ type: 'text', value: key }]), element('dd', {}, [{ type: 'text', value }])]));
      }
      const head = element('div', { className: ['gg-md-code-head'] }, [
        element('span', {}, lang ? [{ type: 'text', value: lang }] : []),
        element('button', { type: 'button', className: ['gg-md-copy'], dataGgCopy: '' }),
      ]);
      return element('div', { className: ['gg-md-code'], ...line }, [head, { ...node, properties }]);
    });
  };
}

/** Text that must never be read as markdown (hook output): one paragraph, spaces and line breaks kept. */
export function plainTextBlock(id: BlockId, text: string): HtmlBlock {
  return { kind: 'html', id, html: `<p class="gg-md-plain">${text.replace(/[&<>]/g, (c) => ESCAPES[c]!)}</p>`, text };
}
