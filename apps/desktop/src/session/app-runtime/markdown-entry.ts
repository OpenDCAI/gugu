import type { ChatHighlighter, HighlightResult } from '@gugu/session-chat-ui/highlight';
import { documentToHtml } from '@gugu/session-chat-ui/markdown-html';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import type { MarkdownTrust } from '@gugu/session-shared/markdown/dialect';
import { APP_RUNTIME_MARKDOWN_CSS } from '@shared/extensions/app-runtime-protocol';
import { revealMarkdownAnchor } from '../../components/markdown/revealAnchor';
import { createMermaidRenderId, renderMermaidDiagram } from '@gugu/session-chat-ui/mermaid';
import { guguError } from './host';

/**
 * `/_gugu/<ver>/markdown.js` — the host's markdown rendering on an App page, behind `gugu.markdown()`.
 *
 * Not a second renderer: the dialect (grammar, sanitize schema, KaTeX), the `.gg-md` look, the code highlighter and the
 * mermaid renderer are the very modules the host's surfaces use, built into the runtime with this gugu; the HTML is the
 * transcript's (`documentToHtml`: image chips, table scroll boxes). An App ships no markdown library and no typography
 * of its own.
 *
 * One verb, `render`: the sanitized markup goes into the page here and nowhere else — no HTML string is handed out for
 * an App to put through `innerHTML` itself. Links follow one policy here too (`followLink`).
 */

type Density = 'compact' | 'comfortable';
type RenderOptions = { trust: MarkdownTrust; density: Density; frontmatter: boolean; sourceLines: boolean; file: unknown };
/** What a link needs of `gugu` (create-gugu.ts hands its own object). */
type LinkVerbs = {
  openLink(url: string): Promise<unknown>;
  reportError(message: string): Promise<unknown>;
  openBrowserTab(url: string): Promise<unknown>;
  files: {
    open(file: unknown, options?: { readOnly?: boolean }): Promise<object>;
    readVersion(file: unknown, n: number): Promise<string | Blob>;
    openWith?(file: unknown, options?: { at?: Record<string, string> }): Promise<unknown>;
  };
};

const TRUSTS: readonly MarkdownTrust[] = ['chat', 'document'];
const DENSITIES: readonly Density[] = ['compact', 'comfortable'];

function optionsOf(value: unknown): RenderOptions {
  const given = (value ?? {}) as Partial<Record<keyof RenderOptions, unknown>>;
  if (typeof given !== 'object') throw guguError('invalid', 'markdown.render(element, text, options): options is an object');
  const trust = given.trust ?? 'chat';
  const density = given.density ?? 'compact';
  if (!TRUSTS.includes(trust as MarkdownTrust)) {
    throw guguError('invalid', `markdown.render: trust is 'chat' (others' words: raw HTML stays text) or 'document', not ${JSON.stringify(trust)}`);
  }
  if (!DENSITIES.includes(density as Density)) {
    throw guguError('invalid', `markdown.render: density is 'compact' or 'comfortable', not ${JSON.stringify(density)}`);
  }
  return { trust: trust as MarkdownTrust, density: density as Density, frontmatter: given.frontmatter === true, sourceLines: given.sourceLines === true, file: given.file };
}

// ── code: the transcript's highlighter, loaded with the first page that has code ──

let highlighter: Promise<{ hl: ChatHighlighter; paint: (code: HTMLElement, result: HighlightResult) => void }> | null = null;
const MAX_HIGHLIGHTED = 200;
const highlighted = new Map<string, HighlightResult>();

const MERMAID = 'pre > code.language-mermaid, pre > code.language-mmd';

function colourCode(root: HTMLElement): void {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]')].filter((code) => !code.matches(MERMAID));
  if (blocks.length === 0) return;
  highlighter ??= import('@gugu/session-chat-ui/highlight').then((m) => ({ hl: m.createDefaultHighlighter(), paint: m.paintHighlight }));
  // Once loaded, this runs as a microtask, before the page paints: a re-render does not flash uncoloured code.
  void highlighter.then(({ hl, paint }) => {
    for (const code of blocks) {
      const lang = /language-(\S+)/.exec(code.className)?.[1];
      const text = code.textContent ?? '';
      const key = `${lang}\u0000${text}`;
      const done = () => {
        let result = highlighted.get(key) ?? null;
        if (!result) {
          result = hl.highlight(text, lang);
          if (!result) return false;
          if (highlighted.size >= MAX_HIGHLIGHTED) highlighted.delete(highlighted.keys().next().value!);
          highlighted.set(key, result);
        }
        if (code.isConnected) paint(code, result);
        return true;
      };
      if (!done()) void hl.load?.(lang)?.then(done);
    }
  });
}

// ── mermaid: the renderer the host's documents use (securityLevel strict), one diagram at a time ──

const MAX_DIAGRAMS = 50;
const diagrams = new Map<string, string>();

function drawDiagrams(root: HTMLElement): void {
  const theme = document.documentElement.dataset.guguTheme === 'dark' ? 'dark' : 'neutral';
  for (const code of root.querySelectorAll<HTMLElement>(MERMAID)) {
    const pre = code.parentElement!;
    const chart = code.textContent ?? '';
    const key = `${theme}\u0000${chart}`;
    const show = (svg: string) => {
      const box = document.createElement('div');
      box.className = 'gg-md-mermaid';
      box.innerHTML = svg;
      pre.replaceWith(box);
    };
    const hit = diagrams.get(key);
    if (hit !== undefined) {
      show(hit);
      continue;
    }
    // A chart mermaid cannot draw stays the code block it was.
    renderMermaidDiagram({ id: createMermaidRenderId(), chart, theme })
      .then((svg) => {
        if (diagrams.size >= MAX_DIAGRAMS) diagrams.delete(diagrams.keys().next().value!);
        diagrams.set(key, svg);
        if (pre.isConnected) show(svg);
      })
      .catch(() => undefined);
  }
}

// ── links: one policy for every App page, the host's ──

/** A relative link in a file (`plan.md`, `./notes/a.md`, `../b.md`) names a file in the same place, beside it. */
function siblingOf(file: unknown, href: string): { chat: string; name: string } | { session: string; name: string } | { project: string; name: string } | null {
  const entry = ((file as { entry?: unknown } | null)?.entry ?? file) as { chat?: unknown; session?: unknown; project?: unknown; name?: unknown; path?: unknown } | null;
  if (!entry || typeof entry !== 'object' || href.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  let path: string;
  try {
    path = decodeURIComponent(href.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  const from = typeof entry.path === 'string' ? entry.path : typeof entry.name === 'string' ? entry.name : '';
  const parts: string[] = [];
  for (const part of `${from.slice(0, from.lastIndexOf('/') + 1)}${path}`.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  if (parts.length === 0) return null;
  const name = parts.join('/');
  if (typeof entry.chat === 'string') return { chat: entry.chat, name };
  if (typeof entry.session === 'string') return { session: entry.session, name };
  if (typeof entry.project === 'string') return { project: entry.project, name };
  return null;
}

/**
 * `#…` scrolls to the heading or footnote in this document; `gugu-file://<id>` opens that chat file where the person is;
 * http(s) opens a browser tab; a relative link opens the file beside this one. Anything else does nothing: an App page
 * has no other way out (`openBrowserTab` takes only http(s)). The opens are the person's click, as their verbs need.
 */
function followLink(root: HTMLElement, gugu: LinkVerbs, file: unknown, href: string): void {
  if (href.startsWith('#')) {
    revealMarkdownAnchor(root, href.slice(1));
    return;
  }
  const failed = (error: unknown) => gugu.reportError(error instanceof Error ? error.message : String(error));
  if (/^https?:\/\//i.test(href)) {
    void gugu.openBrowserTab(href).catch(failed);
    return;
  }
  const sibling = siblingOf(file, href);
  if (sibling) void gugu.files.openWith?.(sibling)?.catch(failed);
  else void gugu.openLink(href).catch(failed);
}

// Images beside a file use the same authorized files API as opening it. Remote sources stay links: neither trust
// level makes an App page fetch a picture from somebody's server on render. Clicking a picture opens its host viewer.
async function resolveImage(gugu: LinkVerbs, ref: unknown, version?: number): Promise<string> {
  let blob: Blob;
  if (version !== undefined) {
    const content = await gugu.files.readVersion(ref, version);
    if (!(content instanceof Blob)) throw new Error('The referenced file is not an image');
    blob = content;
  } else {
    const file = await gugu.files.open(ref, { readOnly: true }) as { type: string; blob(): Promise<Blob>; close(): void };
    try {
      if (file.type !== 'binary') throw new Error('The referenced file is not an image');
      blob = await file.blob();
    } finally {
      file.close();
    }
  }
  if (!blob.type.startsWith('image/')) throw new Error('The referenced file is not an image');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
    reader.readAsDataURL(blob);
  });
}

function drawImages(root: HTMLElement, gugu: LinkVerbs, file: unknown): void {
  for (const chip of root.querySelectorAll<HTMLAnchorElement>('a.gg-md-image[href]')) {
    const href = chip.getAttribute('href')!;
    const link = parseGroupFileLink(href);
    const ref = link ? { id: link.itemId } : siblingOf(file, href);
    if (!ref) continue;
    const alt = chip.textContent ?? '';
    const failed = (cause: unknown) => {
      if (!root.contains(chip)) return;
      chip.className = 'gg-md-image';
      chip.textContent = `${alt}: ${cause instanceof Error ? cause.message : String(cause)}`;
    };
    void resolveImage(gugu, ref, link?.version).then((src) => {
      if (!root.contains(chip)) return;
      const image = Object.assign(document.createElement('img'), { src, alt });
      image.onerror = () => failed(new Error('Could not display the image'));
      chip.className = 'gg-md-inline-image';
      chip.replaceChildren(image);
    }).catch(failed);
  }
}

// ── render ──

type Rendered = { target: Element; root: HTMLElement; text: string; options: RenderOptions; gugu: LinkVerbs };
/** Per element rendered into, and back from its root: weak, so a page that renders into many elements keeps none alive. */
const byTarget = new WeakMap<Element, Rendered>();
const byRoot = new WeakMap<Element, Rendered>();
const ROOT_MARK = 'data-gugu-markdown';

function paint(entry: Rendered): void {
  const { target, root, text, options, gugu } = entry;
  root.className = `gg-md gg-md--${options.density}`;
  // Start with the transcript's sanitized chips, then resolve only file images through the authorized files API.
  // `sourceLines`: each block says the text's lines it came from (`data-line="3-5"`): a page finds a line's block by it.
  root.innerHTML = documentToHtml(text, { trust: options.trust, frontmatter: options.frontmatter, keepImageNodes: true, sourceLines: options.sourceLines });
  // Only when it is not there yet: taking the root out and back would drop the scroll position of a scrolling target.
  if (root.parentNode !== target || target.childNodes.length !== 1) target.replaceChildren(root);
  colourCode(root);
  drawDiagrams(root);
  drawImages(root, gugu, options.file);
}

let themeWatch: MutationObserver | null = null;
/** A diagram is drawn for the page's theme: when the person switches it, the documents on the page are drawn again. */
function watchTheme(): void {
  if (themeWatch) return;
  themeWatch = new MutationObserver(() => {
    for (const root of document.querySelectorAll(`[${ROOT_MARK}]`)) {
      const entry = byRoot.get(root);
      if (entry) paint(entry);
    }
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-gugu-theme'] });
}

/** `render(element, text, options)`: exported for the runtime's own tests; a page reaches it only through `gugu.markdown()`. */
export function renderer(gugu: LinkVerbs) {
  return function render(target: unknown, text: unknown, options?: unknown): void {
    if (!(target instanceof Element)) throw guguError('invalid', 'markdown.render(element, text, options): render into an element of the page');
    if (typeof text !== 'string') throw guguError('invalid', 'markdown.render(element, text, options): text is the markdown, a string');
    const given = optionsOf(options);
    let entry = byTarget.get(target);
    if (!entry) {
      const root = document.createElement('div');
      root.setAttribute(ROOT_MARK, '');
      const made: Rendered = { target, root, text, options: given, gugu };
      root.addEventListener('click', (event) => {
        const link = (event.target as Element | null)?.closest?.('a[href]');
        if (!link || !root.contains(link)) return;
        event.preventDefault();
        followLink(root, gugu, made.options.file, link.getAttribute('href') ?? '');
      });
      byTarget.set(target, made);
      byRoot.set(root, made);
      entry = made;
    }
    entry.text = text;
    entry.options = given;
    paint(entry);
    watchTheme();
  };
}

let sheet: Promise<void> | null = null;
/** `.gg-md` and KaTeX, in `@layer gugu` like ui.css: linked once, before the first render, so nothing paints unstyled. */
function linkSheet(): Promise<void> {
  sheet ??= new Promise<void>((resolve, reject) => {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: new URL(APP_RUNTIME_MARKDOWN_CSS, import.meta.url).href });
    link.onload = () => resolve();
    link.onerror = () => {
      sheet = null;
      link.remove();
      reject(guguError('failed', 'gugu.markdown(): its stylesheet could not be loaded'));
    };
    document.head.append(link);
  });
  return sheet;
}

/** What `gugu.markdown()` resolves to. */
export function markdownFor(gugu: LinkVerbs): Promise<Readonly<{ render: ReturnType<typeof renderer> }>> {
  return linkSheet().then(() => Object.freeze({ render: renderer(gugu) }));
}
